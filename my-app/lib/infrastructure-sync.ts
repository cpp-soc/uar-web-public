import { formatRequestDescription, listUsersInOU, tagAccountWithAccessRequestId, updateUserAttributes } from './ldap';
import { extractBronconame } from './validation';
import { prisma } from './prisma';
import { appLogger } from './logger';

export interface InfrastructureSyncResult {
  syncId: string;
  status: 'completed' | 'partial' | 'failed';
  stats: {
    totalADAccounts: number;
    newAccessRequests: number;
    newVPNAccounts: number;
    skippedDuplicates: number;
    errors: number;
  };
  records: Array<{
    adUsername: string;
    adEmail: string;
    adDisplayName: string;
    action: 'created' | 'skipped_duplicate' | 'error';
    accessRequestId: string | null;
    vpnAccountId: string | null;
    errorMessage?: string;
  }>;
  error?: string;
}

export interface InfrastructureSyncOptions {
  triggeredBy: string;
  dryRun?: boolean;
}

export async function syncInfrastructureAccounts(
  options: InfrastructureSyncOptions
): Promise<InfrastructureSyncResult> {
  const { triggeredBy, dryRun = false } = options;

  appLogger.info('Starting infrastructure sync', { triggeredBy, dryRun });

  const syncRecord = await prisma.aDAccountSync.create({
    data: {
      triggeredBy,
      status: 'running',
      notes: dryRun ? 'Dry run - no records created' : 'Infrastructure sync - creating AccessRequest and VPNAccount records',
    },
  });

  try {
    appLogger.info('Fetching all AD users with @cpp.edu emails');
    const adUsers = await listUsersInOU();
    const cppAdUsers = adUsers.filter(
      (user) => user.email && user.email.toLowerCase().endsWith('@cpp.edu')
    );

    appLogger.info(`Found ${cppAdUsers.length} AD accounts with @cpp.edu emails`);

    if (cppAdUsers.length === 0) {
      await prisma.aDAccountSync.update({
        where: { id: syncRecord.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          totalADAccounts: 0,
          notes: 'No AD accounts found with @cpp.edu emails',
        },
      });

      return {
        syncId: syncRecord.id,
        status: 'completed',
        stats: {
          totalADAccounts: 0,
          newAccessRequests: 0,
          newVPNAccounts: 0,
          skippedDuplicates: 0,
          errors: 0,
        },
        records: [],
      };
    }

    const result = await prisma.$transaction(
      async (tx: any) => {
        const records: InfrastructureSyncResult['records'] = [];
        let newAccessRequests = 0;
        let newVPNAccounts = 0;
        let skippedDuplicates = 0;
        let errors = 0;

        for (const adUser of cppAdUsers) {
          try {
            const bronconame = extractBronconame(adUser.email);
            
            if (!bronconame) {
              appLogger.warn(`Could not extract bronconame from ${adUser.email}`);
              records.push({
                adUsername: 'unknown',
                adEmail: adUser.email,
                adDisplayName: adUser.displayName,
                action: 'error',
                accessRequestId: null,
                vpnAccountId: null,
                errorMessage: 'Could not extract bronconame from email',
              });
              errors++;
              continue;
            }

            const existingAccessRequest = await tx.accessRequest.findFirst({
              where: {
                OR: [
                  { email: adUser.email.toLowerCase() },
                  { ldapUsername: bronconame },
                  { vpnUsername: bronconame },
                  { linkedAdUsername: bronconame },
                ],
              },
            });

            const existingVPNAccount = await tx.vPNAccount.findFirst({
              where: {
                username: bronconame,
              },
            });

            if (existingAccessRequest && existingVPNAccount) {
              appLogger.info(`Skipping ${bronconame} - both records already exist`);
              records.push({
                adUsername: bronconame,
                adEmail: adUser.email,
                adDisplayName: adUser.displayName,
                action: 'skipped_duplicate',
                accessRequestId: existingAccessRequest.id,
                vpnAccountId: existingVPNAccount.id,
              });
              skippedDuplicates++;
              continue;
            }

            if (dryRun) {
              const wouldCreate = [];
              if (!existingAccessRequest) wouldCreate.push('AccessRequest');
              if (!existingVPNAccount) wouldCreate.push('VPNAccount');
              
              appLogger.info(`[DRY RUN] Would create ${wouldCreate.join(' and ')} for ${bronconame}`);
              records.push({
                adUsername: bronconame,
                adEmail: adUser.email,
                adDisplayName: adUser.displayName,
                action: 'created',
                accessRequestId: existingAccessRequest?.id || null,
                vpnAccountId: existingVPNAccount?.id || null,
              });
              continue;
            }

            let accessRequestId = existingAccessRequest?.id || null;
            if (!existingAccessRequest) {
              const newAccessRequest = await tx.accessRequest.create({
                data: {
                  name: adUser.displayName,
                  email: adUser.email.toLowerCase(),
                  isInternal: true,
                  needsDomainAccount: false,
                  status: 'approved',
                  isVerified: true,
                  verifiedAt: new Date(),
                  isManuallyAssigned: true,
                  linkedAdUsername: bronconame,
                  linkedVpnUsername: bronconame,
                  manuallyAssignedBy: triggeredBy,
                  manuallyAssignedAt: new Date(),
                  manualAssignmentNotes: `Auto-created during infrastructure sync - existing AD account ${bronconame}@cpp.edu`,
                  ldapUsername: bronconame,
                  vpnUsername: bronconame,
                  approvedAt: new Date(),
                  approvedBy: triggeredBy,
                  approvalMessage: 'Auto-approved - existing AD infrastructure account',
                  accountCreatedAt: new Date(),
                  provisioningState: 'completed',
                  provisioningCompletedAt: new Date(),
                },
              });
              accessRequestId = newAccessRequest.id;
              newAccessRequests++;
              appLogger.info(`Created AccessRequest for ${bronconame}`);

              // LDAP tagging runs after commit so a directory timeout does not roll back the sync record.
              setImmediate(async () => {
                try {
                  await updateUserAttributes(bronconame, {
                    description: formatRequestDescription(newAccessRequest.id),
                  });
                  appLogger.info(`Updated AD description for ${bronconame}`);
                } catch (descUpdateError) {
                  appLogger.warn(`Failed to update AD description for ${bronconame}`, { error: descUpdateError });
                }
                
                try {
                  await tagAccountWithAccessRequestId(bronconame, newAccessRequest.id);
                  appLogger.info(`Tagged AD account ${bronconame} with Request ID`);
                } catch (tagError) {
                  appLogger.warn(`Failed to tag AD account ${bronconame} with Access Request ID`, { error: tagError });
                }
              });
            } else {
              setImmediate(async () => {
                try {
                  await updateUserAttributes(bronconame, {
                    description: formatRequestDescription(existingAccessRequest.id),
                  });
                  appLogger.info(`Updated AD description for existing request ${bronconame}`);
                } catch (descUpdateError) {
                  appLogger.warn(`Failed to update AD description for existing account ${bronconame}`, { error: descUpdateError });
                }
                
                try {
                  await tagAccountWithAccessRequestId(bronconame, existingAccessRequest.id);
                  appLogger.info(`Tagged existing AD account ${bronconame}`);
                } catch (tagError) {
                  appLogger.warn(`Failed to tag existing AD account ${bronconame}`, { error: tagError });
                }
              });
            }

            let vpnAccountId = existingVPNAccount?.id || null;
            if (!existingVPNAccount) {
              const placeholderPassword = `InfraSync-${Date.now()}-${Math.random().toString(36).substring(7)}`;
              
              const newVPNAccount = await tx.vPNAccount.create({
                data: {
                  username: bronconame,
                  name: adUser.displayName,
                  email: adUser.email.toLowerCase(),
                  portalType: 'Limited',
                  isInternal: true,
                  status: 'active',
                  password: placeholderPassword,
                  createdBy: triggeredBy,
                  createdByFaculty: true,
                  facultyCreatedAt: new Date(),
                  notes: `Auto-created during infrastructure sync - existing AD account ${bronconame}@cpp.edu`,
                  accessRequestId: accessRequestId,
                  adUsername: bronconame,
                },
              });
              vpnAccountId = newVPNAccount.id;
              newVPNAccounts++;
              appLogger.info(`Created VPNAccount for ${bronconame}`);

              await tx.vPNAccountStatusLog.create({
                data: {
                  accountId: newVPNAccount.id,
                  oldStatus: null,
                  newStatus: 'active',
                  changedBy: triggeredBy,
                  reason: 'Infrastructure sync - existing AD account',
                },
              });
            }

            await tx.aDAccountMatch.create({
              data: {
                syncId: syncRecord.id,
                adUsername: bronconame,
                adDisplayName: adUser.displayName,
                adEmail: adUser.email,
                vpnUsername: bronconame,
                vpnAccountId: vpnAccountId,
                accessRequestId: accessRequestId,
                requestEmail: adUser.email,
                requestName: adUser.displayName,
                matchType: 'full_match',
                wasAutoAssigned: true,
                assignedAt: new Date(),
                notes: 'Infrastructure sync - created records for existing AD account',
              },
            });

            records.push({
              adUsername: bronconame,
              adEmail: adUser.email,
              adDisplayName: adUser.displayName,
              action: 'created',
              accessRequestId,
              vpnAccountId,
            });
          } catch (error) {
            appLogger.error(`Error processing AD user ${adUser.email}`, error);
            records.push({
              adUsername: extractBronconame(adUser.email) || 'unknown',
              adEmail: adUser.email,
              adDisplayName: adUser.displayName,
              action: 'error',
              accessRequestId: null,
              vpnAccountId: null,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            errors++;
          }
        }

        await tx.aDAccountSync.update({
          where: { id: syncRecord.id },
          data: {
            status: errors === 0 ? 'completed' : 'partial',
            completedAt: new Date(),
            totalADAccounts: cppAdUsers.length,
            autoAssigned: newAccessRequests + newVPNAccounts,
            notes: dryRun
              ? `[DRY RUN] Would create ${newAccessRequests} AccessRequests and ${newVPNAccounts} VPNAccounts`
              : `Created ${newAccessRequests} AccessRequests and ${newVPNAccounts} VPNAccounts, skipped ${skippedDuplicates} duplicates, ${errors} errors`,
          },
        });

        return {
          records,
          newAccessRequests,
          newVPNAccounts,
          skippedDuplicates,
          errors,
        };
      },
      {
        maxWait: 30000,
        timeout: 180000,
        isolationLevel: 'ReadCommitted',
      }
    );

    appLogger.info('Infrastructure sync completed successfully', {
      syncId: syncRecord.id,
      stats: {
        totalADAccounts: cppAdUsers.length,
        newAccessRequests: result.newAccessRequests,
        newVPNAccounts: result.newVPNAccounts,
        skippedDuplicates: result.skippedDuplicates,
        errors: result.errors,
      },
    });

    return {
      syncId: syncRecord.id,
      status: result.errors === 0 ? 'completed' : 'partial',
      stats: {
        totalADAccounts: cppAdUsers.length,
        newAccessRequests: result.newAccessRequests,
        newVPNAccounts: result.newVPNAccounts,
        skippedDuplicates: result.skippedDuplicates,
        errors: result.errors,
      },
      records: result.records,
    };
  } catch (error) {
    appLogger.error('Infrastructure sync failed - transaction rolled back', error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    try {
      await prisma.aDAccountSync.update({
        where: { id: syncRecord.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: `${errorMessage} - All changes were rolled back`,
          notes: 'Transaction failed - no changes were persisted to database',
        },
      });
    } catch (updateError) {
      appLogger.error('Failed to update sync record with error', updateError);
    }

    return {
      syncId: syncRecord.id,
      status: 'failed',
      stats: {
        totalADAccounts: 0,
        newAccessRequests: 0,
        newVPNAccounts: 0,
        skippedDuplicates: 0,
        errors: 0,
      },
      records: [],
      error: errorMessage,
    };
  }
}

export async function getLatestInfrastructureSync() {
  return await prisma.aDAccountSync.findFirst({
    where: {
      notes: {
        contains: 'Infrastructure sync',
      },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      matches: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

export async function getInfrastructureSyncHistory(limit = 10) {
  return await prisma.aDAccountSync.findMany({
    where: {
      notes: {
        contains: 'Infrastructure sync',
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      _count: {
        select: { matches: true },
      },
    },
  });
}

export async function getInfrastructureSyncById(syncId: string) {
  return await prisma.aDAccountSync.findUnique({
    where: { id: syncId },
    include: {
      matches: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}
