import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const cookie = 'pulse_web_session';
const validKey = /^[A-Za-z0-9_-]{32,128}$/;

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

export function webAccessKey(configured: string | undefined) {
  const key = configured?.trim() || randomBytes(32).toString('base64url');
  if (!validKey.test(key)) {
    throw new Error('PULSE_WEB_ACCESS_KEY должен содержать 32–128 символов A–Z, a–z, 0–9, _ или -.');
  }
  return key;
}

export function webAccess(configured: string) {
  const key = webAccessKey(configured);
  const session = randomBytes(32).toString('base64url');
  const keyHash = digest(key);
  const sessionHash = digest(session);
  return {
    acceptsKey(value: unknown) {
      return typeof value === 'string' && validKey.test(value) && timingSafeEqual(keyHash, digest(value));
    },
    acceptsSession(header: string | undefined) {
      const credentials = header?.split(';').map(value => value.trim()).filter(value => value.startsWith(cookie + '=')) ?? [];
      if (credentials.length !== 1) return false;
      const value = credentials[0].slice(cookie.length + 1);
      return validKey.test(value) && timingSafeEqual(sessionHash, digest(value));
    },
    setCookie: `${cookie}=${session}; Path=/api; HttpOnly; SameSite=Strict; Secure`,
  };
}
