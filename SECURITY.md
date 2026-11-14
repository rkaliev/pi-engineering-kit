# Security policy

## Supported versions

Only the latest release gets security fixes. Update to it before reporting.

## Reporting a vulnerability

Report it privately through GitHub: on the **Security** tab choose **Report a vulnerability** ([new report](https://github.com/rkaliev/pi-engineering-kit/security/advisories/new)). Please don't open a public issue, discussion or pull request for it.

Include:
- the version and how you installed it;
- pi version and OS;
- what an attacker can do, and the steps or input that show it;
- any fix you have in mind.

You get an acknowledgement within 7 days and updates on the report until it is fixed or declined. Fixes are released as a new version and credited in the advisory unless you ask otherwise.

## Scope

The guard and the gates reduce the mistakes of a coding agent working on your behalf (a forgotten check, a destructive command, a leaked secret). They are not a sandbox against a deliberately hostile agent or user, so a way around them by a crafted command is a hardening request rather than a vulnerability, unless it is something an agent plausibly writes on its own.
