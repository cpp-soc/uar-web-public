import { Client } from 'ldapts';
import { getRequiredEnv, getOptionalEnv } from '../env-validator';
import { ldapLogger, hashLogValue } from '../logger';
import { withTimeout, sanitizeLdapError, LDAP_TIMEOUT } from './utils';

/**
 * Creates a new LDAP client instance
 * Enforces LDAPS (secure) connection
 */
export function createLDAPClient(): Client {
  const url = getRequiredEnv('LDAP_URL');

  if (!url.toLowerCase().startsWith('ldaps://')) {
    throw new Error('CRITICAL: LDAP_URL must use ldaps:// transport');
  }

  const allowInvalidCerts = getOptionalEnv('LDAP_ALLOW_INVALID_CERTS', 'true') === 'true';

  return new Client({
    url,
    tlsOptions: {
      rejectUnauthorized: !allowInvalidCerts,
    },
  });
}

/**
 * Authenticate a user against LDAP/Active Directory
 * 
 * @param username - The username or UPN to authenticate
 * @param password - The user's password
 * @returns Object with success/error status
 */
export async function authenticateLDAP(
  username: string,
  password: string
): Promise<{ success: boolean; error?: string }> {
  let client: Client | null = null;
  try {
    if (!username || !password) {
      return { success: false, error: 'Username and password are required' };
    }

    client = createLDAPClient();
    const ldapDomain = getRequiredEnv('LDAP_DOMAIN');

    // Determine the UPN (User Principal Name)
    // If username is already an email/UPN (contains @), use it as is
    // Otherwise, append the domain
    let userDN = username;
    if (!username.includes('@')) {
      userDN = `${username}@${ldapDomain}`;
    }

    await withTimeout(client.bind(userDN, password), LDAP_TIMEOUT);

    return { success: true };
  } catch (error) {
    let errorMessage = 'Authentication failed';
    if (error instanceof Error) {
      if (error.message.includes('timed out')) {
        errorMessage = 'LDAP authentication timeout';
        ldapLogger.error(errorMessage, error);
      } else if (error.message.includes('data 52e')) {
        errorMessage = 'Invalid credentials';
        ldapLogger.warn('LDAP authentication failed: Invalid credentials', { username: hashLogValue(username) });
      } else {
        errorMessage = error.message;
        ldapLogger.error('LDAP authentication failed', sanitizeLdapError(error));
      }
    }
    return { success: false, error: errorMessage };
  } finally {
    if (client) {
      try {
        await client.unbind();
      } catch {
      }
    }
  }
}
