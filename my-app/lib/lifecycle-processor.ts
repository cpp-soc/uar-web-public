import { prisma } from '@/lib/prisma';
import { disableLDAPUser, enableLDAPUser, appendADDescription } from '@/lib/ldap';
import { appLogger } from '@/lib/logger';

export interface ProcessResult {
  success: boolean;
  actionId: string;
  error?: string;
  adCompleted?: boolean;
  vpnCompleted?: boolean;
}

export async function processLifecycleAction(actionId: string): Promise<ProcessResult> {
  const action = await prisma.accountLifecycleAction.findUnique({
    where: { id: actionId },
    include: { batch: true },
  });

  if (!action) {
    throw new Error(`Action ${actionId} not found`);
  }

  if (action.status !== 'processing') {
    throw new Error(`Action ${actionId} is not in processing state: ${action.status}`);
  }

  const originalStatus = action.status;
  let adCompleted = false;
  let vpnCompleted = false;
  let errorMessage: string | undefined;

  try {
    await prisma.accountLifecycleHistory.create({
      data: {
        actionId,
        event: 'processing',
        performedBy: 'system',
        previousStatus: originalStatus,
        newStatus: 'processing',
      },
    });

    switch (action.actionType) {
      case 'disable_ad':
      case 'disable_both':
        await disableADAccount(action);
        adCompleted = true;
        if (action.actionType === 'disable_both') {
          await revokeVPNAccess(action);
          vpnCompleted = true;
        }
        break;

      case 'enable_ad':
      case 'enable_both':
        await enableADAccount(action);
        adCompleted = true;
        if (action.actionType === 'enable_both') {
          await restoreVPNAccess(action);
          vpnCompleted = true;
        }
        break;

      case 'revoke_vpn':
        await revokeVPNAccess(action);
        vpnCompleted = true;
        break;

      case 'restore_vpn':
        await restoreVPNAccess(action);
        vpnCompleted = true;
        break;

      case 'promote_vpn_role':
        await promoteVPNRole(action);
        vpnCompleted = true;
        break;

      case 'demote_vpn_role':
        await demoteVPNRole(action);
        vpnCompleted = true;
        break;

      default:
        throw new Error(`Unknown action type: ${action.actionType}`);
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.accountLifecycleAction.update({
        where: { id: actionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          adDisabled: adCompleted,
          vpnDisabled: vpnCompleted,
        },
      });

      await tx.accountLifecycleHistory.create({
        data: {
          actionId,
          event: 'completed',
          performedBy: 'system',
          previousStatus: 'processing',
          newStatus: 'completed',
          details: JSON.stringify({ adCompleted, vpnCompleted }),
        },
      });

      if (action.batchId) {
        const batch = await tx.accountLifecycleBatch.findUnique({
          where: { id: action.batchId },
        });
        
        if (batch) {
          await tx.accountLifecycleBatch.update({
            where: { id: action.batchId },
            data: {
              completedActions: { increment: 1 },
              status: batch.completedActions + 1 >= batch.totalActions ? 'completed' : 'processing',
              completedAt: batch.completedActions + 1 >= batch.totalActions ? new Date() : null,
            },
          });
        }
      }
    });

    appLogger.info('Lifecycle action completed', {
      actionId,
      actionType: action.actionType,
      targetUsername: action.targetUsername,
    });

    return { success: true, actionId, adCompleted, vpnCompleted };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // PostgreSQL rejects some control characters in error text, so strip them before persisting.
    errorMessage = errorMessage
      .replace(/\0/g, '')
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
      .substring(0, 5000);
    
    try {
      await prisma.$transaction(async (tx: any) => {
        await tx.accountLifecycleAction.update({
          where: { id: actionId },
          data: {
            status: 'failed',
            errorMessage,
            completedAt: new Date(),
            adDisabled: adCompleted,
            vpnDisabled: vpnCompleted,
          },
        });

        await tx.accountLifecycleHistory.create({
          data: {
            actionId,
            event: 'failed',
            performedBy: 'system',
            previousStatus: 'processing',
            newStatus: 'failed',
            details: JSON.stringify({ error: errorMessage, adCompleted, vpnCompleted }),
          },
        });

        if (action.batchId) {
          await tx.accountLifecycleBatch.update({
            where: { id: action.batchId },
            data: {
              failedActions: { increment: 1 },
              completedActions: { increment: 1 },
            },
          });
        }
      });
    } catch (txError) {
      appLogger.error('Failed to record action failure in database', {
        actionId,
        originalError: errorMessage,
        transactionError: txError instanceof Error ? txError.message : 'Unknown',
      });
      
      try {
        await prisma.accountLifecycleAction.update({
          where: { id: actionId },
          data: {
            status: originalStatus,
            processedAt: null,
            processedBy: null,
          },
        });
      } catch (rollbackError) {
        appLogger.error('Failed to rollback action state', {
          actionId,
          error: rollbackError instanceof Error ? rollbackError.message : 'Unknown',
        });
      }
    }

    appLogger.error('Lifecycle action failed', {
      actionId,
      actionType: action.actionType,
      targetUsername: action.targetUsername,
      error: errorMessage,
    });

    return { success: false, actionId, error: errorMessage, adCompleted, vpnCompleted };
  }
}

async function disableADAccount(action: any): Promise<void> {
  const username = action.targetUsername;
  
  const accessRequest = await prisma.accessRequest.findFirst({
    where: {
      OR: [
        { ldapUsername: username },
        { linkedAdUsername: username },
      ],
    },
  });

  if (!accessRequest) {
    throw new Error(`No AccessRequest found for AD username: ${username}`);
  }

  let ldapSuccess = false;
  let ldapErrorMsg: string | undefined;

  try {
    await disableLDAPUser(username);
    
    const noteDetails = [];
    if (action.relatedTicketId) {
      noteDetails.push(`Ticket #${action.relatedTicketId}`);
    }
    if (action.relatedRequestId) {
      noteDetails.push(`Request ${action.relatedRequestId}`);
    }
    const ticketInfo = noteDetails.length > 0 ? ` - ${noteDetails.join(', ')}` : '';
    await appendADDescription(username, `Disabled by UAR${ticketInfo}`);
    
    ldapSuccess = true;
    appLogger.info('Successfully disabled AD account in LDAP', { username });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const ldapError = error as any;
    const isNotFoundError = 
      errorMessage.includes('not found in directory') ||
      errorMessage.includes('NO_OBJECT') ||
      errorMessage.includes('problem 2001') ||
      ldapError?.code === 32 ||
      ldapError?.code === '32';
    
    if (isNotFoundError) {
      appLogger.warn('AD account not found in LDAP, updating database status only', { 
        username, 
        error: errorMessage 
      });
      ldapErrorMsg = errorMessage;
    } else {
      throw error;
    }
  }

  await prisma.$transaction(async (tx: any) => {
    await tx.accessRequest.update({
      where: { id: accessRequest.id },
      data: {
        adAccountStatus: 'disabled',
        adDisabledAt: new Date(),
        adDisabledBy: action.requestedBy,
        adDisabledReason: action.reason,
      },
    });

    await tx.aDAccountActivityLog.create({
      data: {
        accountId: accessRequest.id,
        accountUsername: username,
        accountName: accessRequest.name,
        accountEmail: accessRequest.email,
        actionType: 'disabled',
        performedBy: action.requestedBy,
        reason: action.reason,
        lifecycleActionId: action.id,
        notes: action.notes,
        ldapSuccess,
        ldapError: ldapErrorMsg,
      },
    });
  });

  appLogger.info('AD account disabled', { username, reason: action.reason });
}

async function enableADAccount(action: any): Promise<void> {
  const username = action.targetUsername;
  
  const accessRequest = await prisma.accessRequest.findFirst({
    where: {
      OR: [
        { ldapUsername: username },
        { linkedAdUsername: username },
      ],
    },
  });

  if (!accessRequest) {
    throw new Error(`No AccessRequest found for AD username: ${username}`);
  }

  if (accessRequest.adAccountStatus !== 'disabled') {
    // Keep going so a stale DB flag does not block recovery of the live directory account.
    appLogger.warn('Account not in disabled state in database, attempting enable anyway', { 
      username, 
      currentStatus: accessRequest.adAccountStatus 
    });
  }

  let ldapSuccess = false;
  let ldapErrorMsg: string | undefined;

  try {
    await enableLDAPUser(username);
    
    const noteDetails = [];
    if (action.relatedTicketId) {
      noteDetails.push(`Ticket #${action.relatedTicketId}`);
    }
    if (action.relatedRequestId) {
      noteDetails.push(`Request ${action.relatedRequestId}`);
    }
    const ticketInfo = noteDetails.length > 0 ? ` - ${noteDetails.join(', ')}` : '';
    await appendADDescription(username, `Enabled by UAR${ticketInfo}`);
    
    ldapSuccess = true;
    appLogger.info('Successfully enabled AD account in LDAP', { username });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const ldapError = error as any;
    const isNotFoundError = 
      errorMessage.includes('not found in directory') ||
      errorMessage.includes('NO_OBJECT') ||
      errorMessage.includes('problem 2001') ||
      ldapError?.code === 32 ||
      ldapError?.code === '32';
    
    if (isNotFoundError) {
      ldapErrorMsg = `Cannot enable account - AD user '${username}' does not exist in LDAP directory (NO_OBJECT error)`;
      throw new Error(ldapErrorMsg);
    }
    throw error;
  }

  await prisma.$transaction(async (tx: any) => {
    await tx.accessRequest.update({
      where: { id: accessRequest.id },
      data: {
        adAccountStatus: 'active',
        adEnabledAt: new Date(),
        adEnabledBy: action.requestedBy,
      },
    });

    await tx.aDAccountActivityLog.create({
      data: {
        accountId: accessRequest.id,
        accountUsername: username,
        accountName: accessRequest.name,
        accountEmail: accessRequest.email,
        actionType: 'enabled',
        performedBy: action.requestedBy,
        reason: action.reason,
        lifecycleActionId: action.id,
        notes: action.notes,
        ldapSuccess,
        ldapError: ldapErrorMsg,
      },
    });
  });

  appLogger.info('AD account enabled', { username });
}

async function revokeVPNAccess(action: any): Promise<void> {
  const username = action.targetUsername;
  
  const vpnAccount = await prisma.vPNAccount.findUnique({
    where: { username },
  });

  if (!vpnAccount) {
    throw new Error(`No VPN account found for username: ${username}`);
  }

  if (vpnAccount.status === 'revoked') {
    throw new Error(`VPN account ${username} is already revoked`);
  }

  const noteDetails = [];
  if (action.relatedTicketId) {
    noteDetails.push(`Ticket #${action.relatedTicketId}`);
  }
  if (action.relatedRequestId) {
    noteDetails.push(`Request ${action.relatedRequestId}`);
  }
  const ticketInfo = noteDetails.length > 0 ? ` - ${noteDetails.join(', ')}` : '';
  const detailedReason = `${action.reason}${ticketInfo}`;

  await prisma.$transaction(async (tx: any) => {
    await tx.vPNAccount.update({
      where: { username },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: action.requestedBy,
        revokedReason: detailedReason,
        canRestore: action.canRestore ?? true,
      },
    });

    await tx.vPNAccountStatusLog.create({
      data: {
        accountId: vpnAccount.id,
        oldStatus: vpnAccount.status,
        newStatus: 'revoked',
        changedBy: action.requestedBy,
        reason: detailedReason,
      },
    });

    await tx.vPNAccountActivityLog.create({
      data: {
        accountId: vpnAccount.id,
        accountUsername: username,
        accountName: vpnAccount.name,
        accountEmail: vpnAccount.email,
        actionType: 'revoked',
        performedBy: action.requestedBy,
        reason: action.reason,
        lifecycleActionId: action.id,
        notes: action.notes,
      },
    });

    if (vpnAccount.accessRequestId) {
      await tx.accessRequest.update({
        where: { id: vpnAccount.accessRequestId },
        data: {
          vpnAccountStatus: 'revoked',
          vpnRevokedAt: new Date(),
          vpnRevokedBy: action.requestedBy,
          vpnRevokedReason: detailedReason,
        },
      });
    }
  });

  appLogger.info('VPN access revoked', { username, reason: detailedReason });
}

async function restoreVPNAccess(action: any): Promise<void> {
  const username = action.targetUsername;
  
  const vpnAccount = await prisma.vPNAccount.findUnique({
    where: { username },
  });

  if (!vpnAccount) {
    throw new Error(`No VPN account found for username: ${username}`);
  }

  if (vpnAccount.status !== 'revoked') {
    throw new Error(`VPN account ${username} is not in revoked state, current status: ${vpnAccount.status}`);
  }

  if (!vpnAccount.canRestore) {
    throw new Error(`VPN account ${username} cannot be restored`);
  }

  const noteDetails = [];
  if (action.relatedTicketId) {
    noteDetails.push(`Ticket #${action.relatedTicketId}`);
  }
  if (action.relatedRequestId) {
    noteDetails.push(`Request ${action.relatedRequestId}`);
  }
  const ticketInfo = noteDetails.length > 0 ? ` - ${noteDetails.join(', ')}` : '';
  const detailedReason = `Restored: ${action.reason}${ticketInfo}`;

  await prisma.$transaction(async (tx: any) => {
    await tx.vPNAccount.update({
      where: { username },
      data: {
        status: 'active',
        restoredAt: new Date(),
        restoredBy: action.requestedBy,
      },
    });

    await tx.vPNAccountStatusLog.create({
      data: {
        accountId: vpnAccount.id,
        oldStatus: 'revoked',
        newStatus: 'active',
        changedBy: action.requestedBy,
        reason: detailedReason,
      },
    });

    await tx.vPNAccountActivityLog.create({
      data: {
        accountId: vpnAccount.id,
        accountUsername: username,
        accountName: vpnAccount.name,
        accountEmail: vpnAccount.email,
        actionType: 'restored',
        performedBy: action.requestedBy,
        reason: action.reason,
        lifecycleActionId: action.id,
        notes: action.notes,
      },
    });

    if (vpnAccount.accessRequestId) {
      await tx.accessRequest.update({
        where: { id: vpnAccount.accessRequestId },
        data: {
          vpnAccountStatus: 'active',
          vpnRestoredAt: new Date(),
          vpnRestoredBy: action.requestedBy,
        },
      });
    }
  });

  appLogger.info('VPN access restored', { username });
}

async function promoteVPNRole(action: any): Promise<void> {
  const username = action.targetUsername;
  
  const vpnAccount = await prisma.vPNAccount.findUnique({
    where: { username },
  });

  if (!vpnAccount) {
    throw new Error(`No VPN account found for username: ${username}`);
  }

  if (vpnAccount.portalType === 'Management') {
    throw new Error(`VPN account ${username} is already in Management portal`);
  }

  if (vpnAccount.portalType === 'External') {
    throw new Error(`Cannot promote External portal accounts to Management`);
  }

  const previousRole = vpnAccount.portalType;

  await prisma.$transaction(async (tx: any) => {
    await tx.vPNAccount.update({
      where: { username },
      data: {
        portalType: 'Management',
        expiresAt: null,
      },
    });

    await tx.vPNRoleChange.create({
      data: {
        vpnAccountId: vpnAccount.id,
        username,
        previousRole,
        newRole: 'Management',
        changedBy: action.requestedBy,
        reason: action.reason,
        relatedActionId: action.id,
        notes: action.notes,
      },
    });

    await tx.vPNAccountStatusLog.create({
      data: {
        accountId: vpnAccount.id,
        oldStatus: vpnAccount.status,
        newStatus: vpnAccount.status,
        changedBy: action.requestedBy,
        reason: `Role promoted: ${previousRole} -> Management. ${action.reason}`,
      },
    });

    await tx.vPNAccountActivityLog.create({
      data: {
        accountId: vpnAccount.id,
        accountUsername: username,
        accountName: vpnAccount.name,
        accountEmail: vpnAccount.email,
        actionType: 'role_promoted',
        performedBy: action.requestedBy,
        reason: action.reason,
        lifecycleActionId: action.id,
        oldPortalType: previousRole,
        newPortalType: 'Management',
        notes: action.notes,
      },
    });
  });

  appLogger.info('VPN role promoted', { username, from: previousRole, to: 'Management' });
}

async function demoteVPNRole(action: any): Promise<void> {
  const username = action.targetUsername;
  
  const vpnAccount = await prisma.vPNAccount.findUnique({
    where: { username },
  });

  if (!vpnAccount) {
    throw new Error(`No VPN account found for username: ${username}`);
  }

  if (vpnAccount.portalType !== 'Management') {
    throw new Error(`VPN account ${username} is not in Management portal, current: ${vpnAccount.portalType}`);
  }

  const previousRole = vpnAccount.portalType;

  await prisma.$transaction(async (tx: any) => {
    await tx.vPNAccount.update({
      where: { username },
      data: {
        portalType: 'Limited',
      },
    });

    await tx.vPNRoleChange.create({
      data: {
        vpnAccountId: vpnAccount.id,
        username,
        previousRole,
        newRole: 'Limited',
        changedBy: action.requestedBy,
        reason: action.reason,
        relatedActionId: action.id,
        notes: action.notes,
      },
    });

    await tx.vPNAccountStatusLog.create({
      data: {
        accountId: vpnAccount.id,
        oldStatus: vpnAccount.status,
        newStatus: vpnAccount.status,
        changedBy: action.requestedBy,
        reason: `Role demoted: ${previousRole} -> Limited. ${action.reason}`,
      },
    });

    await tx.vPNAccountActivityLog.create({
      data: {
        accountId: vpnAccount.id,
        accountUsername: username,
        accountName: vpnAccount.name,
        accountEmail: vpnAccount.email,
        actionType: 'role_demoted',
        performedBy: action.requestedBy,
        reason: action.reason,
        lifecycleActionId: action.id,
        oldPortalType: previousRole,
        newPortalType: 'Limited',
        notes: action.notes,
      },
    });
  });

  appLogger.info('VPN role demoted', { username, from: previousRole, to: 'Limited' });
}

async function updateBatchStats(batchId: string): Promise<void> {
  const batch = await prisma.accountLifecycleBatch.findUnique({
    where: { id: batchId },
    include: {
      actions: {
        select: { status: true },
      },
    },
  });

  if (!batch) return;

  const completedActions = batch.actions.filter((a: any) => a.status === 'completed').length;
  const failedActions = batch.actions.filter((a: any) => a.status === 'failed').length;
  const totalProcessed = completedActions + failedActions;

  let batchStatus = batch.status;
  let completedAt = batch.completedAt;

  if (totalProcessed === batch.totalActions) {
    batchStatus = failedActions === 0 ? 'completed' : 
                  completedActions === 0 ? 'failed' : 'partial';
    completedAt = new Date();
  } else if (totalProcessed > 0) {
    batchStatus = 'processing';
  }

  await prisma.accountLifecycleBatch.update({
    where: { id: batchId },
    data: {
      status: batchStatus,
      completedActions,
      failedActions,
      completedAt,
    },
  });
}

export async function processNextQueuedAction(): Promise<ProcessResult | null> {
  const nextAction = await prisma.accountLifecycleAction.findFirst({
    where: {
      status: 'queued',
      OR: [
        { scheduledFor: null },
        { scheduledFor: { lte: new Date() } },
      ],
    },
    orderBy: [
      { createdAt: 'asc' },
    ],
  });

  if (!nextAction) {
    return null;
  }

  return await processLifecycleAction(nextAction.id);
}

export async function processAllQueuedActions(): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  
  let nextResult = await processNextQueuedAction();
  while (nextResult) {
    results.push(nextResult);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    nextResult = await processNextQueuedAction();
  }

  return results;
}

export async function retryFailedAction(actionId: string): Promise<boolean> {
  try {
    const action = await prisma.accountLifecycleAction.findUnique({
      where: { id: actionId },
    });

    if (!action) {
      throw new Error(`Action ${actionId} not found`);
    }

    if (action.status !== 'failed') {
      throw new Error(`Action ${actionId} is not in failed state (current: ${action.status})`);
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.accountLifecycleAction.update({
        where: { id: actionId },
        data: {
          status: 'queued',
          errorMessage: null,
          processedAt: null,
          processedBy: null,
          completedAt: null,
        },
      });

      await tx.accountLifecycleHistory.create({
        data: {
          actionId,
          event: 'retry',
          performedBy: 'system',
          previousStatus: 'failed',
          newStatus: 'queued',
          details: JSON.stringify({ retryReason: 'Manual retry requested' }),
        },
      });
    });

    appLogger.info('Lifecycle action reset for retry', { actionId });
    return true;
  } catch (error) {
    appLogger.error('Failed to retry action', {
      actionId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

export async function cancelLifecycleAction(actionId: string, cancelledBy: string): Promise<boolean> {
  try {
    const action = await prisma.accountLifecycleAction.findUnique({
      where: { id: actionId },
    });

    if (!action) {
      throw new Error(`Action ${actionId} not found`);
    }

    if (action.status !== 'pending' && action.status !== 'queued') {
      throw new Error(`Action ${actionId} cannot be cancelled (current: ${action.status})`);
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.accountLifecycleAction.update({
        where: { id: actionId },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          notes: `${action.notes || ''}\n[Cancelled by ${cancelledBy}]`.trim(),
        },
      });

      await tx.accountLifecycleHistory.create({
        data: {
          actionId,
          event: 'cancelled',
          performedBy: cancelledBy,
          previousStatus: action.status,
          newStatus: 'cancelled',
        },
      });
    });

    appLogger.info('Lifecycle action cancelled', { actionId, cancelledBy });
    return true;
  } catch (error) {
    appLogger.error('Failed to cancel action', {
      actionId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

