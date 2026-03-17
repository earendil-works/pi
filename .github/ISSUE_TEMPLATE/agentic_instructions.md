# .github/ISSUE_TEMPLATE

## Purpose
GitHub issue templates for structured bug reports, feature contributions, and configuration.

## Technology
YAML-based GitHub issue template configuration.

## Contents
- `bug.yml` - Bug report template with structured fields
- `contribution.yml` - Contribution proposal template
- `config.yml` - Issue template chooser configuration (controls what appears in the issue creation UI)

## Key Functions
N/A - declarative YAML templates, no executable code.

## Data Types
N/A

## Logging
N/A

## CRUD Entry Points
- **Create**: Add a new `.yml` file to define a new issue template type
- **Read**: GitHub automatically reads templates from this directory
- **Update**: Edit existing `.yml` files to modify template fields
- **Delete**: Remove a `.yml` file to remove that template type

## Style Guide
- Files use YAML syntax with GitHub issue template schema
- Template IDs use kebab-case
- Labels are defined inline in each template
