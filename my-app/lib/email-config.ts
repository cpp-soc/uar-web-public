import { prisma } from './prisma';

/**
 * Email configuration with database-first approach
 * Falls back to environment variables if database values are not set
 */

let cachedSettings: {
  emailFrom?: string | null;
  adminEmail?: string | null;
  facultyEmail?: string | null;
  studentDirectorEmails?: string | null;
} | null = null;

let lastFetchTime = 0;
const CACHE_TTL = 60000; // 1 minute cache

/**
 * Get email configuration from database with fallback to env vars
 * Uses caching to avoid repeated database queries
 */
export async function getEmailConfig() {
  const now = Date.now();
  
  // Return cached settings if still valid
  if (cachedSettings && (now - lastFetchTime) < CACHE_TTL) {
    return {
      emailFrom: cachedSettings.emailFrom || process.env.EMAIL_FROM,
      adminEmail: cachedSettings.adminEmail || process.env.ADMIN_EMAIL,
      facultyEmail: cachedSettings.facultyEmail || process.env.FACULTY_EMAIL,
      studentDirectorEmails: cachedSettings.studentDirectorEmails || process.env.STUDENT_DIRECTOR_EMAILS,
    };
  }

  try {
    // Fetch from database
    const settings = await prisma.systemSettings.findFirst({
      select: {
        emailFrom: true,
        adminEmail: true,
        facultyEmail: true,
        studentDirectorEmails: true,
      },
    });

    // Update cache
    cachedSettings = settings;
    lastFetchTime = now;

    // Return with env fallback
    return {
      emailFrom: settings?.emailFrom || process.env.EMAIL_FROM,
      adminEmail: settings?.adminEmail || process.env.ADMIN_EMAIL,
      facultyEmail: settings?.facultyEmail || process.env.FACULTY_EMAIL,
      studentDirectorEmails: settings?.studentDirectorEmails || process.env.STUDENT_DIRECTOR_EMAILS,
    };
  } catch (error) {
    console.error('[Email Config] Failed to fetch from database, using env vars:', error);
    
    // Fallback to environment variables if database fails
    return {
      emailFrom: process.env.EMAIL_FROM,
      adminEmail: process.env.ADMIN_EMAIL,
      facultyEmail: process.env.FACULTY_EMAIL,
      studentDirectorEmails: process.env.STUDENT_DIRECTOR_EMAILS,
    };
  }
}

/**
 * Clear the email config cache
 * Call this after updating email settings in the database
 */
export function clearEmailConfigCache() {
  cachedSettings = null;
  lastFetchTime = 0;
}

/**
 * Get student director emails as an array
 */
export async function getStudentDirectorEmails(): Promise<string[]> {
  const config = await getEmailConfig();
  const emailsStr = config.studentDirectorEmails || '';
  return emailsStr.split(',').map((e: string) => e.trim()).filter((e: string) => e);
}
