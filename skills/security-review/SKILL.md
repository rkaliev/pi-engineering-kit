---
name: security-review
description: Use when changes touch authentication, authorization, user input, file uploads, secrets, cryptography, dependencies, payments or personal data, or when asked for a security review or audit
---

# Security review

Find the vulnerabilities an attacker would, before they do, and report them precisely enough to fix. Review with the attacker's question: *what input or identity do I control, and where does it go?*

## Process

1. **Scope:** the diff or the components under review, the assets (money, PII, credentials, availability), and the trust boundaries (client ↔ server, service ↔ service, app ↔ device, tenant ↔ tenant).
2. **Threat-model the data flows** (STRIDE as a prompt): spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege. For each boundary, ask what is validated, authenticated, authorized and logged.
3. **Walk the checklist** below against the actual code paths. Trace untrusted input to every sink.
4. **Run the project's tools, or propose them:**
   - secrets scanning (gitleaks, trufflehog);
   - dependency audit (`npm audit`, `osv-scanner`, `pip-audit`, Dependabot or Renovate alerts);
   - SAST (Semgrep, CodeQL);
   - the platform linters (Android Lint security checks, for example).
5. **Report** each finding with:
   - **severity** by real impact and likelihood (Critical / High / Medium / Low);
   - `file:line`;
   - the attack scenario (who, how, what they gain);
   - the fix.
   Separate **Confirmed** from **Needs verification**. Don't pad the report with generic advice.

## Checklist

- **Injection:** parameterized SQL/ORM (no string concatenation); no shell with user input (pass argument arrays); output encoding and a CSP for HTML; path traversal on file access; SSRF on server-side fetches of user-supplied URLs; template, LDAP, XPath and header injection.
- **AuthN:** a vetted library or provider; password hashing with Argon2id/bcrypt/scrypt; MFA where it matters; rate limiting and lockout; secure session cookies (`HttpOnly`, `Secure`, `SameSite`); token expiry and rotation; logout that actually invalidates.
- **AuthZ:** checked server-side on every request, for the specific resource (ownership or tenant; IDOR), deny by default, no trust in client-sent roles or prices.
- **Input and files:** validate against a schema at the boundary; limit sizes; check upload type by content; store uploads outside the web root with generated names; scan them where required.
- **Secrets:** none in code, the repo, logs, crash reports, client bundles or mobile binaries. Use a secret manager with least-privilege scopes, and rotate on exposure.
- **Crypto:** platform or standard libraries only; AES-GCM or ChaCha20-Poly1305; no static IVs; CSPRNG tokens; TLS everywhere with certificate validation on (no "trust all" in production); constant-time comparison for secrets and signatures.
- **Data protection:** minimize PII, encrypt it at rest where required, mask it in logs, set retention and deletion, and respect consent. Personal-data laws (GDPR, 152-ФЗ) can dictate storage location.
- **Web:** CSRF protection for cookie auth, a strict CORS allowlist, security headers, no sensitive data in URLs, and open-redirect checks.
- **Mobile and desktop:** no secrets in the binary; secure storage (Keystore/Keychain/DPAPI); exported components and deep links validated; WebView without universal file access; certificate pinning only with a rotation plan. See OWASP MASVS.
- **Supply chain:** pinned versions and a lockfile, trusted registries, a review of new dependencies (maintenance, popularity, install scripts), a minimal CI token scope, and signed releases.
- **Agent- and LLM-specific:** prompt injection through fetched content or user data reaching tools. Treat model output as untrusted input to any sink.
- **Logging and monitoring:** security events logged without secrets, with alerts on anomalies and tamper-evident audit trails for privileged actions.

Map findings to OWASP Top 10 / ASVS (web), MASVS (mobile) and, for card data, PCI DSS (payments-and-money). Reference the current edition, and check it at the source rather than from memory.
