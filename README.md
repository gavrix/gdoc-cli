# gdoc - Google Docs CLI

Command-line tool for programmatic Google Docs editing via the Docs API. Supports markdown conversion, section-based editing, and search/replace operations.

## Prerequisites

- **Node.js 14+** (tested on 18+)
- **Google account** (personal or workspace)
- **OAuth2 credentials** from Google Cloud Console

**First time?** See [SETUP.md](SETUP.md) for complete step-by-step OAuth2 setup guide.

## Installation

```bash
git clone https://github.com/gavrix/gdoc-cli.git
cd gdoc-cli
npm install
npm link  # Makes 'gdoc' available globally
```

## Authentication

gdoc uses OAuth2 to authenticate as you, giving you access to all documents you can personally access (including org-shared docs).

### First-time Setup

**See [SETUP.md](SETUP.md) for detailed step-by-step instructions.**

Quick version:
1. Create OAuth2 credentials in Google Cloud Console
2. Download credentials and save as `~/.gdoc/credentials.json`
3. Run `gdoc auth` to authenticate

```bash
gdoc auth
```

Your browser will open, you'll click "Allow", and your token will be saved for future use.

After authentication, all commands work automatically - no need to specify auth method.

## Commands

### Document Operations

#### Get Document
```bash
gdoc documents.get --documentId <id>
```
Returns full document JSON structure.

#### Create Document
```bash
gdoc documents.create --title "My Document"
```

#### Batch Update
```bash
gdoc documents.batchUpdate --documentId <id> --requests '[...]'
```

### Markdown Conversion

#### Convert Markdown to Google Doc
```bash
# Create new document
gdoc markdown -f input.md -t "My Document"

# Update existing document
gdoc markdown -f input.md -d <documentId>
```

**Supported markdown features:**
- Headings (H1-H6)
- Bold, italic, bold+italic
- Inline code and code blocks
- Unordered and ordered lists
- Links
- Tables (multi-pass insertion with proper cell population)

### Section Management

#### List Document Sections
```bash
gdoc list-sections --documentId <id>

# Output as JSON
gdoc list-sections --documentId <id> --json
```

Shows hierarchical outline based on heading structure.

#### Read Section Content
```bash
gdoc read-section --documentId <id> --title "Introduction"
```

Partial title matching (case-insensitive).

#### Update Section
```bash
gdoc update-section --documentId <id> --title "Features" -f content.md
```

Replaces section content (preserves heading) with markdown conversion.

#### Append to Section
```bash
gdoc append-to-section --documentId <id> --title "Conclusion" -f addendum.md
```

Adds content at end of section.

#### Insert New Section
```bash
# Insert before existing section
gdoc insert-section --documentId <id> --title "New Section" --level 2 \
  --before "Existing Section" -f content.md

# Insert after existing section
gdoc insert-section --documentId <id> --title "New Section" --level 2 \
  --after "Existing Section" -f content.md
```

#### Delete Section
```bash
gdoc delete-section --documentId <id> --title "Deprecated"

# Skip confirmation
gdoc delete-section --documentId <id> --title "Deprecated" --confirm
```

Removes heading + all content.

### Search & Replace

#### Search
```bash
# Search entire document
gdoc search --documentId <id> --query "TODO"

# Search within section
gdoc search-section --documentId <id> --section "Introduction" --query "TODO"
```

Returns matches with context and character indices.

#### Find & Replace
```bash
# Replace all occurrences (case-insensitive)
gdoc replace --documentId <id> --find "old text" --replace "new text"

# Preview changes before applying
gdoc replace --documentId <id> --find "old text" --replace "new text" --preview
```

**Note**: Search and replace are always case-insensitive.

## Common Workflows

### Convert Markdown to Google Doc
```bash
gdoc markdown -f document.md -t "Project Spec"
# Returns document URL
```

### Update Specific Section
```bash
# 1. List sections to find title
gdoc list-sections --documentId <id>

# 2. Update section from markdown
gdoc update-section --documentId <id> --title "Implementation" -f impl.md
```

### Search and Replace Across Document
```bash
# Find occurrences
gdoc search --documentId <id> --query "API v1"

# Replace all
gdoc replace --documentId <id> --find "API v1" --replace "API v2"
```

### Build Document Programmatically
```bash
# Create base document
DOC_ID=$(gdoc markdown -f template.md -t "Report" | jq -r .documentId)

# Append sections
gdoc append-to-section --documentId $DOC_ID --title "Results" -f results.md
gdoc append-to-section --documentId $DOC_ID --title "Analysis" -f analysis.md
```

## Architecture

### Key Components

**gdoc.js** - Main CLI using Commander.js
- Document CRUD operations
- Markdown conversion orchestration
- Section editing commands
- Search/replace operations

**markdown-to-docs.js** - Markdown parser & converter
- Uses `marked` lexer for tokenization
- Generates Google Docs API batch requests
- Handles inline formatting (bold, italic, links, code)
- Multi-pass table insertion

**document-sections.js** - Document structure parser
- Parses heading hierarchy into sections
- Section boundary calculation
- Search within sections
- Delete/update request generation

### Technical Notes

**Index-based editing**: Google Docs uses 1-based character indices. All operations must calculate correct positions including newlines.

**Batch requests**: Most operations use `batchUpdate` for atomicity. Multiple requests execute in order within single API call.

**Table insertion**: Tables require 3-step process:
1. Insert table structure (rows × cols)
2. Read back document to get cell positions
3. Populate cell content with proper indices

**Section boundaries**: Sections span from heading start to next same-or-higher-level heading. Calculated from document structure on each operation.

## Troubleshooting

**Error: Requested entity was not found**
- Check document ID is correct
- Verify you have access to view/edit the document (check sharing settings)

**Formatting not applied**
- Verify markdown syntax (use `**bold**`, `*italic*`, `` `code` ``)
- Check that indices don't overlap in batch requests

**Tables appear empty**
- Multi-pass table insertion may have failed
- Try re-converting entire document

**Section not found**
- Use `list-sections` to see exact titles
- Section matching is partial and case-insensitive

## Examples

See `test.md` for comprehensive markdown example with all supported features.

## License

MIT
