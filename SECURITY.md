# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in wispbot, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **najibelmokhtari@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce the issue
- Any relevant logs or screenshots

You should receive a response within 48 hours. We'll work with you to understand the issue and coordinate a fix before any public disclosure.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Considerations

wispbot handles WhatsApp messages and connects to external AI APIs. Keep these things in mind when deploying:

- **API keys** — Store your Gemini API key and any Google Cloud credentials in `.env`, never commit them to version control
- **Admin panel** — Use a strong `ADMIN_PASSWORD`. Bind to `127.0.0.1` (default) unless you need remote access, and use a reverse proxy with HTTPS if exposing to the internet
- **Session data** — WhatsApp session credentials are stored in `auth_session/`. Protect this directory — anyone with these files can impersonate your bot's WhatsApp account
- **Database** — `data/database.sqlite` contains message history and user information. Restrict file permissions appropriately
- **Dependencies** — Run `npm audit` periodically to check for known vulnerabilities in dependencies
