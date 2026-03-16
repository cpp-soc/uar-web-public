import { Client, Attribute, Change } from 'ldapts';
import { getRequiredEnv, getOptionalEnv } from '../env-validator';
import { ldapLogger } from '../logger';
import { createLDAPClient } from './client';
import { 
  withTimeout, 
  withRetry,
  escapeLDAPDN,
  validatePasswordForLDAP,
  LDAP_TIMEOUT 
} from './utils';

/**
 * Set password for a new LDAP user account
 */
export async function setLDAPUserPassword(
  username: string,
  password: string
): Promise<boolean> {
  return await withRetry(async () => {
    const url = getRequiredEnv('LDAP_URL');
    const bindDN = getRequiredEnv('LDAP_BIND_DN');
    const bindPassword = getRequiredEnv('LDAP_BIND_PASSWORD');
    const searchBase = getRequiredEnv('LDAP_SEARCH_BASE');
    const isLdaps = url.startsWith('ldaps://');

    if (!isLdaps) {
      try {
        ldapLogger.info('Attempting password change with STARTTLS (required for AD password changes)');
        const allowInvalidCerts = getOptionalEnv('LDAP_ALLOW_INVALID_CERTS', 'true') === 'true';
        const client = new Client({
          url,
          tlsOptions: {
            rejectUnauthorized: !allowInvalidCerts,
          },
        });

        await withTimeout(client.startTLS({
          rejectUnauthorized: !allowInvalidCerts,
        }), LDAP_TIMEOUT);

        ldapLogger.info('STARTTLS established, now binding');

        await withTimeout(client.bind(bindDN, bindPassword), LDAP_TIMEOUT);

        const sanitizedUsername = escapeLDAPDN(username);
        const userDN = `CN=${sanitizedUsername},${searchBase}`;

        ldapLogger.info('Changing password for user', { userDN });

        validatePasswordForLDAP(password);

        const newPassword = `"${password}"`;
        const passwordBuffer = Buffer.from(newPassword, 'utf16le');

        const change = new Change({
          operation: 'replace',
          modification: new Attribute({
            type: 'unicodePwd',
            values: [passwordBuffer]
          })
        });

        await withTimeout(client.modify(userDN, change), LDAP_TIMEOUT);
        await client.unbind();

        ldapLogger.info('Password changed successfully with STARTTLS');
        return true;
      } catch (error: unknown) {
        const err = error as { code?: number; message?: string };
        ldapLogger.error('STARTTLS password change failed', err);

        if (err.code === 53 || (err.message && err.message.includes('WILL_NOT_PERFORM'))) {
          ldapLogger.error('AD refuses to change password - connection may not be secure enough');
          throw new Error('Active Directory requires a secure connection (LDAPS) to change passwords.');
        }

        throw new Error(`Failed to change password: ${err.message || 'Unknown error'}`);
      }
    }

    try {
      ldapLogger.info('Attempting password change with LDAPS');
      const client = createLDAPClient();

      await withTimeout(client.bind(bindDN, bindPassword), LDAP_TIMEOUT);

      const sanitizedUsername = escapeLDAPDN(username);
      const userDN = `CN=${sanitizedUsername},${searchBase}`;

      ldapLogger.info('Changing password for user', { userDN });

      validatePasswordForLDAP(password);

      const newPassword = `"${password}"`;
      const passwordBuffer = Buffer.from(newPassword, 'utf16le');

      const change = new Change({
        operation: 'replace',
        modification: new Attribute({
          type: 'unicodePwd',
          values: [passwordBuffer]
        })
      });

      await withTimeout(client.modify(userDN, change), LDAP_TIMEOUT);
      await client.unbind();

      ldapLogger.info('Password changed successfully with LDAPS');
      return true;
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      ldapLogger.error('LDAPS password change failed', err);

      if (err.code === 53 || (err.message && err.message.includes('WILL_NOT_PERFORM'))) {
        throw new Error('Active Directory is refusing the password change. Please contact your administrator.');
      }

      throw new Error(`Failed to change password: ${err.message || 'Unknown error'}`);
    }
  }, 'setLDAPUserPassword');
}

/**
 * Change password for an existing LDAP user (password reset)
 */
export async function changeLDAPUserPassword(
  username: string,
  newPassword: string,
  userDN?: string
): Promise<boolean> {
  const url = process.env.LDAP_URL || 'ldap://localhost:389';
  const isLdaps = url.startsWith('ldaps://');

  const sanitizedUsername = escapeLDAPDN(username);

  const dn = userDN || `CN=${sanitizedUsername},${process.env.LDAP_SEARCH_BASE}`;

  ldapLogger.info('Changing password for user', { username, dn });

  if (!isLdaps) {
    try {
      ldapLogger.info('Attempting password change with STARTTLS');
      const client = new Client({
        url,
        tlsOptions: {
          rejectUnauthorized: false,
        },
      });

      await withTimeout(client.startTLS({
        rejectUnauthorized: false,
      }), LDAP_TIMEOUT);

      ldapLogger.info('STARTTLS established, now binding');

      await withTimeout(client.bind(
        process.env.LDAP_BIND_DN || '',
        process.env.LDAP_BIND_PASSWORD || ''
      ), LDAP_TIMEOUT);

      const newPasswordFormatted = `"${newPassword}"`;
      const passwordBuffer = Buffer.from(newPasswordFormatted, 'utf16le');

      const change = new Change({
        operation: 'replace',
        modification: new Attribute({
          type: 'unicodePwd',
          values: [passwordBuffer]
        })
      });

      await withTimeout(client.modify(dn, change), LDAP_TIMEOUT);
      await client.unbind();

      ldapLogger.info('Password changed successfully with STARTTLS');
      return true;
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      ldapLogger.error('STARTTLS password change failed', err);

      if (err.code === 53 || (err.message && err.message.includes('WILL_NOT_PERFORM'))) {
        throw new Error('Active Directory requires a secure connection (LDAPS) to change passwords.');
      }

      throw new Error(`Failed to change password: ${err.message || 'Unknown error'}`);
    }
  }

  try {
    ldapLogger.info('Attempting password change with LDAPS');
    const client = new Client({
      url,
      tlsOptions: {
        rejectUnauthorized: false,
      },
    });

    await withTimeout(client.bind(
      process.env.LDAP_BIND_DN || '',
      process.env.LDAP_BIND_PASSWORD || ''
    ), LDAP_TIMEOUT);

    const newPasswordFormatted = `"${newPassword}"`;
    const passwordBuffer = Buffer.from(newPasswordFormatted, 'utf16le');

    const change = new Change({
      operation: 'replace',
      modification: new Attribute({
        type: 'unicodePwd',
        values: [passwordBuffer]
      })
    });

    await withTimeout(client.modify(dn, change), LDAP_TIMEOUT);
    await client.unbind();

    ldapLogger.info('Password changed successfully with LDAPS');
    return true;
  } catch (error: unknown) {
    const err = error as { code?: number; message?: string };
    ldapLogger.error('LDAPS password change failed', err);

    if (err.code === 53 || (err.message && err.message.includes('WILL_NOT_PERFORM'))) {
      throw new Error('Active Directory is refusing the password change. Please contact your administrator.');
    }

    throw new Error(`Failed to change password: ${err.message || 'Unknown error'}`);
  }
}
