Test-only, self-signed certificate for `tests/database-tls.test.ts`. It is
valid for 127.0.0.1 and localhost until 2126 and protects nothing. Regenerate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout server-key.pem \
  -out server-cert.pem -days 36500 -subj "/CN=Slideo test database" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
```
