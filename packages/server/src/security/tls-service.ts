import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SystemSettings, TlsStatus } from '@serverforge/shared';

// --- Minimal Zero-Dependency ASN.1 DER Encoder (RFC 5280 X.509 v3) ---

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00 && (bytes[start + 1] & 0x80) === 0) {
    start++;
  }
  let sliced = bytes.subarray(start);
  if (sliced[0] & 0x80) {
    sliced = Buffer.concat([Buffer.from([0x00]), sliced]);
  }
  return derTag(0x02, sliced);
}

function derBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function derOctetString(bytes: Buffer): Buffer {
  return derTag(0x04, bytes);
}

function derBoolean(val: boolean): Buffer {
  return Buffer.from([0x01, 0x01, val ? 0xff : 0x00]);
}

function derUtf8String(str: string): Buffer {
  return derTag(0x0c, Buffer.from(str, 'utf8'));
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map((p) => Number(p));
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const encoded: number[] = [val & 0x7f];
    val >>>= 7;
    while (val > 0) {
      encoded.unshift((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    out.push(...encoded);
  }
  return derTag(0x06, Buffer.from(out));
}

function derTime(date: Date): Buffer {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  if (yyyy >= 1950 && yyyy <= 2049) {
    const yy = String(yyyy).slice(-2);
    return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${min}${ss}Z`, 'ascii'));
  }
  return derTag(0x18, Buffer.from(`${yyyy}${mm}${dd}${hh}${min}${ss}Z`, 'ascii'));
}

function derRdn(oid: string, value: string): Buffer {
  return derSet([derSequence([derOid(oid), derUtf8String(value)])]);
}

function ipv4ToBytes(ip: string): Buffer | null {
  if (net.isIPv4(ip)) {
    return Buffer.from(ip.split('.').map((part) => Number(part)));
  }
  return null;
}

function derExtension(oid: string, valueDer: Buffer, critical = false): Buffer {
  const parts: Buffer[] = [derOid(oid)];
  if (critical) parts.push(derBoolean(true));
  parts.push(derOctetString(valueDer));
  return derSequence(parts);
}

function pemWrap(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface GeneratedCertificate {
  certPem: string;
  keyPem: string;
  fingerprint256: string;
  validFrom: string;
  validTo: string;
  sans: string[];
}

/**
 * Generates a pure-Node self-signed X.509 v3 ECDSA P-256 TLS certificate with Subject Alternative Names
 * covering localhost, 127.0.0.1, the detected LAN IP, and local hostname (.local).
 */
export function generateSelfSignedCertificate(options: {
  dnsNames?: string[];
  ipAddresses?: string[];
  commonName?: string;
  daysValid?: number;
} = {}): GeneratedCertificate {
  const commonName = options.commonName ?? 'ServerForge Local';
  const daysValid = Math.max(1, Math.min(825, options.daysValid ?? 730));

  const dnsSet = new Set<string>(['localhost']);
  for (const d of options.dnsNames ?? []) {
    const clean = d.trim().toLowerCase();
    if (clean && !net.isIP(clean)) dnsSet.add(clean);
  }

  const ipSet = new Set<string>(['127.0.0.1']);
  for (const ip of options.ipAddresses ?? []) {
    const clean = ip.trim();
    if (net.isIPv4(clean)) ipSet.add(clean);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  // Positive 16-byte serial number
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] &= 0x7f;
  if (serialBytes[0] === 0) serialBytes[0] = 0x01;

  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2) — no parameters per RFC 5758
  const sigAlg = derSequence([derOid('1.2.840.10045.4.3.2')]);

  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(Date.now() + daysValid * 24 * 60 * 60_000);

  const name = derSequence([
    derRdn('2.5.4.10', 'ServerForge'),
    derRdn('2.5.4.3', commonName),
  ]);

  const sanEntries: Buffer[] = [];
  const sansList: string[] = [];
  for (const dns of dnsSet) {
    sanEntries.push(derTag(0x82, Buffer.from(dns, 'ascii')));
    sansList.push(`DNS:${dns}`);
  }
  for (const ip of ipSet) {
    const buf = ipv4ToBytes(ip);
    if (buf) {
      sanEntries.push(derTag(0x87, buf));
      sansList.push(`IP:${ip}`);
    }
  }

  const extensions = derSequence([
    // BasicConstraints: CA:TRUE (allows trusting the single cert directly on Windows/iOS/macOS)
    derExtension('2.5.29.19', derSequence([derBoolean(true)]), true),
    // KeyUsage: digitalSignature (bit 0) + keyCertSign (bit 5) = 0x84 with 2 unused bits
    derExtension('2.5.29.15', derBitString(Buffer.from([0x84]), 2), true),
    // ExtKeyUsage: id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
    derExtension('2.5.29.37', derSequence([derOid('1.3.6.1.5.5.7.3.1')]), false),
    // SubjectAltName
    derExtension('2.5.29.17', derSequence(sanEntries), false),
  ]);

  const tbsCertificate = derSequence([
    derTag(0xa0, derInteger(Buffer.from([0x02]))), // version v3 (2)
    derInteger(serialBytes),
    sigAlg,
    name, // issuer
    derSequence([derTime(notBefore), derTime(notAfter)]),
    name, // subject
    spkiDer,
    derTag(0xa3, extensions),
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certDer = derSequence([tbsCertificate, sigAlg, derBitString(signature, 0)]);
  const certPem = pemWrap('CERTIFICATE', certDer);

  const x509 = new crypto.X509Certificate(certPem);
  return {
    certPem,
    keyPem,
    fingerprint256: x509.fingerprint256,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    sans: sansList,
  };
}

function parseSansFromX509(x509: crypto.X509Certificate): string[] {
  const raw = x509.subjectAltName ?? '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateCertAndKey(certPem: string, keyPem: string): crypto.X509Certificate {
  const x509 = new crypto.X509Certificate(certPem);
  const privKey = crypto.createPrivateKey(keyPem);
  if (!x509.checkPrivateKey(privKey)) {
    throw new Error('TLS certificate and private key do not match.');
  }
  return x509;
}

export interface StartupTlsResult {
  httpsOptions: { cert: string; key: string } | null;
  status: TlsStatus;
}

export class TlsService {
  public readonly tlsDir: string;
  public readonly localCertPath: string;
  public readonly localKeyPath: string;

  private active = false;
  private activeMode: 'self_signed' | 'custom' = 'self_signed';
  private fallbackReason: string | null = null;

  constructor(private readonly dataDir: string) {
    this.tlsDir = path.join(dataDir, 'tls');
    this.localCertPath = path.join(this.tlsDir, 'server.crt');
    this.localKeyPath = path.join(this.tlsDir, 'server.key');
  }

  private buildHostSanCandidates(lanIp?: string | null): { dnsNames: string[]; ipAddresses: string[] } {
    const dnsNames = ['localhost'];
    const host = os.hostname().trim().toLowerCase();
    if (host && /^[a-z0-9.-]+$/.test(host)) {
      dnsNames.push(host);
      if (!host.endsWith('.local')) {
        dnsNames.push(`${host}.local`);
      }
    }
    const ipAddresses = ['127.0.0.1'];
    if (lanIp && net.isIPv4(lanIp)) {
      ipAddresses.push(lanIp);
    }
    return { dnsNames, ipAddresses };
  }

  regenerateLocalCertificate(lanIp?: string | null): GeneratedCertificate {
    fs.mkdirSync(this.tlsDir, { recursive: true });
    const { dnsNames, ipAddresses } = this.buildHostSanCandidates(lanIp);
    const generated = generateSelfSignedCertificate({ dnsNames, ipAddresses });
    fs.writeFileSync(this.localCertPath, generated.certPem, { encoding: 'utf8', mode: 0o644 });
    fs.writeFileSync(this.localKeyPath, generated.keyPem, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(this.localKeyPath, 0o600);
    } catch {
      // ignore on Windows NTFS
    }
    return generated;
  }

  ensureLocalCertificate(lanIp?: string | null): { certPem: string; keyPem: string; x509: crypto.X509Certificate } {
    if (fs.existsSync(this.localCertPath) && fs.existsSync(this.localKeyPath)) {
      try {
        const certPem = fs.readFileSync(this.localCertPath, 'utf8');
        const keyPem = fs.readFileSync(this.localKeyPath, 'utf8');
        const x509 = validateCertAndKey(certPem, keyPem);
        const expiresMs = Date.parse(x509.validTo);
        const sans = parseSansFromX509(x509);
        const hasLanIp = !lanIp || !net.isIPv4(lanIp) || sans.some((s) => s === `IP Address:${lanIp}` || s === `IP:${lanIp}`);
        const stillFresh = Number.isFinite(expiresMs) && expiresMs - Date.now() > 14 * 24 * 60 * 60_000;
        if (stillFresh && hasLanIp) {
          return { certPem, keyPem, x509 };
        }
      } catch {
        // Regenerate corrupted/invalid local cert
      }
    }
    const generated = this.regenerateLocalCertificate(lanIp);
    return {
      certPem: generated.certPem,
      keyPem: generated.keyPem,
      x509: new crypto.X509Certificate(generated.certPem),
    };
  }

  resolveStartupTls(settings: SystemSettings, lanIp?: string | null): StartupTlsResult {
    this.active = false;
    this.activeMode = settings.httpsCertMode;
    this.fallbackReason = null;

    if (!settings.httpsEnabled) {
      return {
        httpsOptions: null,
        status: this.getStatus(settings),
      };
    }

    if (settings.httpsCertMode === 'custom') {
      const certPath = settings.httpsCertPath.trim();
      const keyPath = settings.httpsKeyPath.trim();
      if (!certPath || !keyPath) {
        this.fallbackReason =
          'Custom HTTPS mode is enabled, but certificate or key path is empty. Fell back to HTTP.';
        return { httpsOptions: null, status: this.getStatus(settings) };
      }
      try {
        const certPem = fs.readFileSync(certPath, 'utf8');
        const keyPem = fs.readFileSync(keyPath, 'utf8');
        validateCertAndKey(certPem, keyPem);
        this.active = true;
        return {
          httpsOptions: { cert: certPem, key: keyPem },
          status: this.getStatus(settings),
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unable to read custom TLS certificate/key';
        this.fallbackReason = `Custom HTTPS certificate failed to load (${reason}). Safely fell back to HTTP.`;
        return { httpsOptions: null, status: this.getStatus(settings) };
      }
    }

    try {
      const { certPem, keyPem } = this.ensureLocalCertificate(lanIp);
      this.active = true;
      return {
        httpsOptions: { cert: certPem, key: keyPem },
        status: this.getStatus(settings),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Failed to generate local TLS certificate';
      this.fallbackReason = `Local HTTPS certificate initialization failed (${reason}). Safely fell back to HTTP.`;
      return { httpsOptions: null, status: this.getStatus(settings) };
    }
  }

  getCertificatePemForDownload(settings: SystemSettings, lanIp?: string | null): string {
    if (settings.httpsCertMode === 'custom' && settings.httpsCertPath.trim()) {
      return fs.readFileSync(settings.httpsCertPath.trim(), 'utf8');
    }
    return this.ensureLocalCertificate(lanIp).certPem;
  }

  getStatus(settings: SystemSettings): TlsStatus {
    const mode = settings.httpsCertMode;
    const certPath =
      mode === 'custom'
        ? settings.httpsCertPath.trim() || null
        : fs.existsSync(this.localCertPath)
          ? this.localCertPath
          : null;
    const keyPath =
      mode === 'custom'
        ? settings.httpsKeyPath.trim() || null
        : fs.existsSync(this.localKeyPath)
          ? this.localKeyPath
          : null;

    let fingerprint256: string | null = null;
    let validFrom: string | null = null;
    let validTo: string | null = null;
    let sans: string[] = [];

    if (certPath && fs.existsSync(certPath)) {
      try {
        const x509 = new crypto.X509Certificate(fs.readFileSync(certPath, 'utf8'));
        fingerprint256 = x509.fingerprint256;
        validFrom = x509.validFrom;
        validTo = x509.validTo;
        sans = parseSansFromX509(x509);
      } catch {
        // leave metadata null if cert is invalid
      }
    }

    const restartRequired =
      settings.httpsEnabled !== this.active ||
      (this.active && settings.httpsCertMode !== this.activeMode);

    return {
      enabled: settings.httpsEnabled,
      active: this.active,
      mode,
      certPath,
      keyPath,
      fingerprint256,
      validFrom,
      validTo,
      sans,
      fallbackReason: this.fallbackReason,
      restartRequired,
    };
  }
}
