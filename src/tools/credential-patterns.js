const CREDENTIAL_LABEL_PATTERN =
  /(?:token|key|secret|password|passwd|bearer|authorization|cookie|credential|private|api[_-]?key|access[_-]?key|refresh[_-]?token|database_url|jwt|数据库地址|访问令牌|密钥|密码)/iu;

const CREDENTIAL_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{3,}\b/iu,
  /-----BEGIN\s+[A-Z ]+(?:PRIVATE KEY|CERTIFICATE)-----/u,
  /\b(?:eyJ[A-Za-z0-9_-]{8,}\.){2}[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/iu,
  /\bnpm_[A-Za-z0-9]{8,}\b/iu,
  /\b(?:pypi-|xox[baprs]-)[A-Za-z0-9_-]{6,}\b/iu,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{2,}\b/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+(?::[^\s/@]+)?@[^\s]+/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]+[?&](?:token|key|secret|password|access_token|api_key)=[^&#\s]*/iu,
  /(?:^|[\s"'&,])(?:database_url|aws_secret_access_key)\s*=\s*\S+/iu,
  /(?:^|[\s"'&,])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|jwt|bearer)\s*[:=]\s*\S+/iu,
];

const HIGH_ENTROPY_MIN_LENGTH = 32;

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function decodedText(value) {
  if (
    value.length < 24
    || value.length % 4 === 1
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return "";
  }
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(decoded)) {
      return "";
    }
    return decoded;
  } catch {
    return "";
  }
}

function decodedCredentialText(text) {
  const candidates = String(text).match(/[A-Za-z0-9+/]{24,}={0,2}/gu) ?? [];
  return candidates
    .map((candidate) => decodedText(candidate))
    .filter(Boolean)
    .join("\n");
}

function directCredentialMatch(text) {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(text))
    || /(?:访问令牌|密钥|密码)\s*[:=]\s*\S+/u.test(text)
    || /\bMII[A-Za-z0-9+/]{20,}={0,2}\b/u.test(text);
}

export function normalizedLabel(label) {
  return String(label ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[\s-]+/gu, "_")
    .replaceAll(/[^\p{L}\p{N}_]+/gu, "")
    .slice(0, 128);
}

export function looksLikeCredential(label, value) {
  const normalized = normalizedLabel(label);
  const text = `${normalized}\n${String(value ?? "")}`;
  if (CREDENTIAL_LABEL_PATTERN.test(normalized) || directCredentialMatch(text)) return true;

  const candidate = String(value ?? "");
  const decoded = decodedText(candidate) || decodedCredentialText(candidate);
  if (decoded !== "" && directCredentialMatch(decoded)) return true;

  return candidate.length >= HIGH_ENTROPY_MIN_LENGTH
    && /^[A-Za-z0-9+/=_-]+$/u.test(candidate)
    && shannonEntropy(candidate) >= 3.5;
}
