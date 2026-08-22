/**
 * Clerk stores bcrypt digests. Better Auth defaults to scrypt.
 * Use bcrypt for hash + verify so migrated Clerk passwords keep working.
 */
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  return bcrypt.compare(data.password, data.hash);
}
