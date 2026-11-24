import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

const expectedFingerprint = 'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31';
export const russianCaFilename = 'Russian_Trusted_Root_CA.cer';
const defaultCertificatePath = fileURLToPath(new URL(`../../cert/${russianCaFilename}`, import.meta.url));

export class TlsProfileError extends Error {
  readonly code = 'ERR_TLS_PROFILE_CA';
}

let cached: { path: string; roots: string[]; startsAt: number; endsAt: number } | undefined;

export function russianTrustRoots() {
  const certificatePath = process.env.PULSE_RUSSIAN_CA_FILE || defaultCertificatePath;
  if (cached?.path !== certificatePath) {
    try {
      const bytes = readFileSync(certificatePath);
      const certificate = new X509Certificate(bytes);
      const singleCertificate = certificate.raw.equals(bytes)
        || /^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(bytes.toString('utf8').trim());
      if (!certificate.ca || certificate.fingerprint256 !== expectedFingerprint
        || !singleCertificate || !certificate.verify(certificate.publicKey)) {
        throw new Error('Отпечаток или назначение российского CA не совпадает.');
      }
      cached = {
        path: certificatePath,
        roots: [...getCACertificates('default'), certificate.toString()],
        startsAt: Date.parse(certificate.validFrom),
        endsAt: Date.parse(certificate.validTo),
      };
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
      throw new TlsProfileError(missing
        ? 'Файл российского CA отсутствует. Скачайте Russian Trusted Root CA с Госуслуг и подключите по инструкции в README.'
        : 'Файл российского CA не прошёл проверку.', { cause });
    }
  }
  const now = Date.now();
  if (now < cached.startsAt || now > cached.endsAt) {
    throw new TlsProfileError('Российский CA находится вне срока действия.');
  }
  return cached.roots;
}
