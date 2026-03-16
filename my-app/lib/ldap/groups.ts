import { Client, Attribute, Change } from 'ldapts';
import { getRequiredEnv } from '../env-validator';
import { ldapLogger } from '../logger';
import { createLDAPClient } from './client';
import { 
  withTimeout, 
  sanitizeLdapError,
  LDAP_TIMEOUT 
} from './utils';

/**
 * Search for AD groups matching a query string
 */
export async function searchLDAPGroups(query: string): Promise<Array<{
  dn: string;
  name: string;
  description: string;
}>> {
  let client: Client | null = null;
  try {
    client = createLDAPClient();
    const bindDN = getRequiredEnv('LDAP_BIND_DN');
    const bindPassword = getRequiredEnv('LDAP_BIND_PASSWORD');
    const groupSearchBase = getRequiredEnv('LDAP_GROUPSEARCH');

    await withTimeout(client.bind(bindDN, bindPassword), LDAP_TIMEOUT);

    // Sanitize query to prevent injection
    const sanitizedQuery = query.replace(/[()*\\]/g, '');

    const filter = sanitizedQuery
      ? `(&(objectClass=group)(cn=*${sanitizedQuery}*))`
      : '(&(objectClass=group)(cn=*))';

    const opts = {
      filter,
      scope: 'sub' as const,
      sizeLimit: 1000,
      attributes: ['cn', 'description', 'distinguishedName'],
    };

    const { searchEntries } = await withTimeout(client.search(groupSearchBase, opts), LDAP_TIMEOUT);

    return searchEntries.map((entry: any) => ({
      dn: String(entry.dn),
      name: String(entry.cn),
      description: String(entry.description || ''),
    }));
  } catch (err) {
    ldapLogger.error('Error searching LDAP groups', sanitizeLdapError(err as Record<string, unknown>));
    throw err;
  } finally {
    if (client) {
      try {
        await client.unbind();
      } catch (unbindErr) {
        ldapLogger.error('Error unbinding connection', unbindErr);
      }
    }
  }
}

/**
 * Get all members of a specific AD group
 */
export async function getLDAPGroupMembers(groupDN: string): Promise<Array<{
  dn: string;
  username: string;
  displayName: string;
}>> {
  let client: Client | null = null;
  try {
    client = createLDAPClient();
    const bindDN = getRequiredEnv('LDAP_BIND_DN');
    const bindPassword = getRequiredEnv('LDAP_BIND_PASSWORD');

    await withTimeout(client.bind(bindDN, bindPassword), LDAP_TIMEOUT);

    const opts = {
      scope: 'base' as const,
      attributes: ['member'],
    };

    const { searchEntries } = await withTimeout(client.search(groupDN, opts), LDAP_TIMEOUT);

    if (searchEntries.length === 0) {
      throw new Error(`Group not found: ${groupDN}`);
    }

    const members = searchEntries[0].member;
    if (!members) return [];

    const memberDNs = Array.isArray(members) ? members : [members];

    // Resolve member DNs to user details (up to 100 members)
    const resolvedMembers: Array<{ dn: string; username: string; displayName: string }> = [];
    const maxResolve = 100;

    for (let i = 0; i < Math.min(memberDNs.length, maxResolve); i++) {
      const memberDN = String(memberDNs[i]);
      try {
        const memberOpts = {
          scope: 'base' as const,
          attributes: ['sAMAccountName', 'displayName', 'cn'],
        };
        const { searchEntries: memberEntries } = await withTimeout(client.search(memberDN, memberOpts), LDAP_TIMEOUT);

        if (memberEntries.length > 0) {
          const entry = memberEntries[0];
          resolvedMembers.push({
            dn: String(entry.dn),
            username: String(entry.sAMAccountName || entry.cn),
            displayName: String(entry.displayName || entry.cn),
          });
        }
      } catch (e) {
        ldapLogger.warn(`Failed to resolve member ${memberDN}`, e as Record<string, unknown>);
      }
    }

    return resolvedMembers;
  } catch (err) {
    ldapLogger.error('Error getting LDAP group members', sanitizeLdapError(err as Record<string, unknown>));
    throw err;
  } finally {
    if (client) {
      try {
        await client.unbind();
      } catch (unbindErr) {
        ldapLogger.error('Error unbinding connection', unbindErr);
      }
    }
  }
}

/**
 * Add a user to an AD group
 */
export async function addLDAPGroupMember(groupDN: string, userDN: string): Promise<boolean> {
  let client: Client | null = null;
  try {
    client = createLDAPClient();
    const bindDN = getRequiredEnv('LDAP_BIND_DN');
    const bindPassword = getRequiredEnv('LDAP_BIND_PASSWORD');

    await withTimeout(client.bind(bindDN, bindPassword), LDAP_TIMEOUT);

    const change = new Change({
      operation: 'add',
      modification: new Attribute({
        type: 'member',
        values: [userDN]
      })
    });

    await withTimeout(client.modify(groupDN, change), LDAP_TIMEOUT);

    ldapLogger.info('Added user to group', { groupDN, userDN });
    return true;
  } catch (err: any) {
    // Check if error is "already exists" (code 68)
    if (err.code === 68 || (err.message && err.message.includes('already exists'))) {
      ldapLogger.info('User already in group', { groupDN, userDN });
      return true;
    }

    ldapLogger.error('Error adding user to group', sanitizeLdapError(err));
    throw err;
  } finally {
    if (client) {
      try {
        await client.unbind();
      } catch (unbindErr) {
        ldapLogger.error('Error unbinding connection', unbindErr);
      }
    }
  }
}

/**
 * Remove a user from an AD group
 */
export async function removeLDAPGroupMember(groupDN: string, userDN: string): Promise<boolean> {
  let client: Client | null = null;
  try {
    client = createLDAPClient();
    const bindDN = getRequiredEnv('LDAP_BIND_DN');
    const bindPassword = getRequiredEnv('LDAP_BIND_PASSWORD');

    await withTimeout(client.bind(bindDN, bindPassword), LDAP_TIMEOUT);

    const change = new Change({
      operation: 'delete',
      modification: new Attribute({
        type: 'member',
        values: [userDN]
      })
    });

    await withTimeout(client.modify(groupDN, change), LDAP_TIMEOUT);

    ldapLogger.info('Removed user from group', { groupDN, userDN });
    return true;
  } catch (err: any) {
    // Check if error is "no such attribute" (user not in group)
    if (err.code === 53 || err.code === 16 || (err.message && err.message.includes('unwilling to perform'))) {
      ldapLogger.warn('User not in group or cannot remove', { groupDN, userDN, error: err.message });
      return true;
    }

    ldapLogger.error('Error removing user from group', sanitizeLdapError(err));
    throw err;
  } finally {
    if (client) {
      try {
        await client.unbind();
      } catch (unbindErr) {
        ldapLogger.error('Error unbinding connection', unbindErr);
      }
    }
  }
}
