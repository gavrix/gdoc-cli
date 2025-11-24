# gdoc - Guide for AI Agents

This document provides guidance for AI agents (like Claude) working with the Google Docs CLI tool.

## Overview

`gdoc` enables programmatic manipulation of Google Docs via command-line interface. It's particularly useful for:
- Converting markdown content to formatted Google Docs
- Updating specific sections of documents without touching other content
- Searching and replacing text across documents
- Building/maintaining living documentation

## Authentication Context

The tool uses **OAuth2 authentication**. The user must authenticate once using:
```bash
gdoc auth
```

This opens the browser for Google authentication and saves a token to:
```
~/.gdoc/token.json
```

**Important**:
- The tool authenticates as the user, inheriting all their Google Docs permissions
- Works with org-wide shared documents automatically
- No need to explicitly share documents with any service account
- Token persists across sessions until manually removed or expired

## Core Concepts

### 1. Document IDs
Google Docs are identified by document IDs from their URLs:
```
https://docs.google.com/document/d/1Gvc7cCnzuqKN8Ab7927rG5110_bnV6ffN8g6cxCavK8/edit
                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                   This is the document ID
```

### 2. Character Indices
Google Docs API uses 1-based character indexing:
- Index 1 = first character
- Newlines count as characters
- All ranges are `[startIndex, endIndex)` (exclusive end)

### 3. Section-Based Structure
Documents are parsed into sections based on heading hierarchy:
- H1 creates top-level section
- H2 creates subsection under previous H1
- Section includes heading + all content until next same-or-higher-level heading

### 4. Batch Operations
Most operations use `batchUpdate` API:
- Multiple requests execute in single API call
- Requests processed in order
- Index calculations must account for previous operations

## Agent Workflows

### Workflow 1: Create Document from Markdown

**Use case**: User provides markdown content, wants formatted Google Doc

**Steps**:
1. Save markdown to temporary file (or use existing file)
2. Run markdown conversion command
3. Return document URL to user

**Example**:
```bash
# User provides markdown string
echo "$MARKDOWN_CONTENT" > /tmp/doc.md

# Convert to Google Doc
gdoc markdown -f /tmp/doc.md -t "Document Title"

# Returns JSON with documentId and url
```

**Important**:
- Markdown must be saved to file first (command requires `-f` flag)
- Use `-d` flag to update existing document instead of creating new

### Workflow 2: Update Specific Section

**Use case**: User wants to modify one section without affecting rest of document

**Steps**:
1. List sections to verify target section exists
2. Prepare new content as markdown
3. Update section with new content

**Example**:
```bash
# 1. Verify section exists
gdoc list-sections --documentId <id>

# 2. Prepare new content
echo "# Updated Content\n\nNew paragraph." > /tmp/section.md

# 3. Update section
gdoc update-section --documentId <id> --title "Implementation" -f /tmp/section.md
```

**Important**:
- Section matching is partial and case-insensitive
- Only content is replaced, heading is preserved
- New content fully replaces old (not a merge)

### Workflow 3: Search and Modify

**Use case**: Find and replace text patterns across document

**Steps**:
1. Search to verify matches exist (optional but recommended)
2. Perform replacement
3. Verify results if needed

**Example**:
```bash
# 1. Preview matches
gdoc search --documentId <id> --query "API v1"

# 2. Replace all occurrences
gdoc replace --documentId <id> --find "API v1" --replace "API v2"

# 3. Verify (optional)
gdoc search --documentId <id> --query "API v2"
```

**Important**:
- Search and replace are always case-insensitive
- Replace operates on all matches in document
- No undo - verify critical changes with `--preview` first

### Workflow 4: Incremental Document Building

**Use case**: Build document piece by piece from multiple sources

**Steps**:
1. Create initial document structure
2. Append sections as they're generated
3. Update individual sections as needed

**Example**:
```bash
# 1. Create base structure
DOC_ID=$(gdoc markdown -f template.md -t "Report" | jq -r .documentId)

# 2. Add sections incrementally
gdoc append-to-section --documentId $DOC_ID --title "Introduction" -f intro.md
gdoc append-to-section --documentId $DOC_ID --title "Methods" -f methods.md

# 3. Later, update specific section
gdoc update-section --documentId $DOC_ID --title "Methods" -f methods-revised.md
```

### Workflow 5: Extract and Analyze

**Use case**: Read document content for analysis or transformation

**Steps**:
1. List sections to understand structure
2. Read specific sections
3. Process content as needed

**Example**:
```bash
# 1. Get document outline
OUTLINE=$(gdoc list-sections --documentId <id> --json)

# 2. Read specific section
CONTENT=$(gdoc read-section --documentId <id> --title "Results")

# 3. Process with other tools
echo "$CONTENT" | analyze-tool
```

## Markdown Conversion Details

### Supported Syntax

**Text formatting**:
- `**bold**` → bold text
- `*italic*` → italic text
- `***bold italic***` → both styles
- `` `inline code` `` → monospace with gray background

**Headings**:
```markdown
# Heading 1
## Heading 2
### Heading 3
```
Maps to Google Docs `HEADING_1`, `HEADING_2`, `HEADING_3` (up to H6)

**Lists**:
```markdown
- Unordered item
- Another item

1. Ordered item
2. Another item
```

**Links**:
```markdown
[Link text](https://example.com)
```

**Code blocks**:
````markdown
```
function example() {
  return true;
}
```
````
Rendered with monospace font and gray background.

**Tables**:
```markdown
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
```

### Known Limitations

1. **No syntax highlighting** in code blocks (Google Docs API limitation)
2. **No images** - must be added manually after conversion
3. **Tables are basic** - no cell merging, complex formatting
4. **No nested lists** - all lists are single-level
5. **Links are plain** - no link text formatting (bold/italic in links not supported)

## Error Handling

### Common Errors

**"Requested entity was not found"**
- Document ID is wrong, or
- User doesn't have access to the document
- **Solution**: Verify document ID is correct and that you have access to view/edit it

**"Section not found: <title>"**
- Section title doesn't match
- **Solution**: Run `list-sections` to see exact titles

**"File not found: <path>"**
- Markdown file path is incorrect
- **Solution**: Verify file exists, use absolute paths

**Formatting applied incorrectly**
- Usually due to index calculation bugs
- **Solution**: Re-run conversion on entire document

### Debugging Strategies

1. **Use `documents.get`** to inspect raw document structure:
   ```bash
   gdoc documents.get --documentId <id> | jq '.body.content'
   ```

2. **Use `list-sections`** to verify document structure:
   ```bash
   gdoc list-sections --documentId <id>
   ```

3. **Test on small documents first** before operating on production docs

4. **Use search to verify changes**:
   ```bash
   gdoc search --documentId <id> --query "expected text"
   ```

## Best Practices for Agents

### 1. Always Verify Document Access
Before performing operations, consider checking if document is accessible:
```bash
gdoc list-sections --documentId <id> 2>&1
```
If this fails, document is not accessible.

### 2. Use Temporary Files for Markdown
When converting markdown strings to docs, write to temp files:
```bash
TEMP_FILE=$(mktemp)
echo "$MARKDOWN_CONTENT" > "$TEMP_FILE"
gdoc markdown -f "$TEMP_FILE" -t "Document Title"
rm "$TEMP_FILE"
```

### 3. Parse Output for Document IDs
When creating documents, parse the JSON response:
```bash
RESULT=$(gdoc markdown -f input.md -t "Title")
DOC_ID=$(echo "$RESULT" | jq -r .documentId)
DOC_URL=$(echo "$RESULT" | jq -r .url)
```

### 4. Section Matching is Fuzzy
Title matching is partial and case-insensitive:
- `--title "intro"` matches "Introduction"
- `--title "RESULTS"` matches "Results"

Use exact titles when possible for clarity.

### 5. Preserve User Intent for Sections
When updating sections:
- If user says "replace", use `update-section`
- If user says "add to end", use `append-to-section`
- If user wants new section, use `insert-section`

### 6. Clean Up Temporary Files
Always remove temp markdown files after operations.

### 7. Return Actionable URLs
After document operations, provide Google Docs URL:
```
https://docs.google.com/document/d/{documentId}/edit
```

## Technical Implementation Notes

### Index Offset Calculations

When inserting content at specific positions, all indices must be adjusted:

```javascript
// Converter generates requests starting at index 1
// To insert at position N, add offset (N - 1) to all indices

const insertIndex = section.headingEndIndex;  // e.g., 250
const indexOffset = insertIndex - 1;          // 249

contentRequests.forEach(req => {
  if (req.insertText) {
    req.insertText.location.index += indexOffset;
  }
  if (req.updateTextStyle) {
    req.updateTextStyle.range.startIndex += indexOffset;
    req.updateTextStyle.range.endIndex += indexOffset;
  }
  // ... similar for other request types
});
```

**Critical**: Must adjust ALL request types that reference indices, including:
- `insertText`
- `updateTextStyle`
- `updateParagraphStyle`
- `createParagraphBullets`

### Nested Token Processing

Markdown tokens can be nested (e.g., text with inline formatting). The `extractPlainText` function must process nested tokens BEFORE checking for raw text:

```javascript
extractPlainText(tokens) {
  for (const token of tokens) {
    // Check for nested tokens FIRST
    if (token.tokens && token.tokens.length > 0) {
      text += this.extractPlainText(token.tokens);
    }
    // Then fallback to raw text
    else if (token.text) {
      text += token.text;
    }
  }
}
```

This prevents raw markdown markers (like `**bold**`) from appearing in output.

### Table Multi-Pass Insertion

Tables require special handling:

**Pass 1**: Insert table structure
```javascript
{
  insertTable: {
    rows: 3,
    columns: 2,
    location: { index: 100 }
  }
}
```

**Pass 2**: Read document to get cell positions
```javascript
const doc = await docs.documents.get({ documentId });
const table = findTableAtIndex(doc, 100);
const cellPositions = extractCellPositions(table);
```

**Pass 3**: Insert content into each cell
```javascript
for (const cell of cellData) {
  const cellIndex = cellPositions[cell.row][cell.col];
  await insertTextIntoCell(cellIndex, cell.text);
}
```

## Integration Examples

### Example 1: Documentation Generator

```bash
#!/bin/bash
# Generate API documentation from source code

# Extract docs from code
extract-docs src/ > /tmp/api-docs.md

# Convert to Google Doc
RESULT=$(gdoc markdown -f /tmp/api-docs.md -t "API Documentation $(date +%Y-%m-%d)")
DOC_URL=$(echo "$RESULT" | jq -r .url)

echo "Documentation generated: $DOC_URL"
```

### Example 2: Report Builder

```bash
#!/bin/bash
# Build weekly report from various sources

# Create base document
DOC_ID=$(gdoc markdown -f template.md -t "Weekly Report" | jq -r .documentId)

# Add sections from different sources
gdoc append-to-section --documentId "$DOC_ID" --title "Metrics" -f metrics.md
gdoc append-to-section --documentId "$DOC_ID" --title "Incidents" -f incidents.md
gdoc append-to-section --documentId "$DOC_ID" --title "Plans" -f next-week.md

echo "Report: https://docs.google.com/document/d/$DOC_ID/edit"
```

### Example 3: Document Synchronization

```bash
#!/bin/bash
# Keep Google Doc in sync with markdown file

DOC_ID="1Gvc7cCnzuqKN8Ab7927rG5110_bnV6ffN8g6cxCavK8"
MARKDOWN_FILE="README.md"

# Update document when markdown changes
gdoc markdown -f "$MARKDOWN_FILE" -d "$DOC_ID"
echo "Document synchronized with $MARKDOWN_FILE"
```

## Conclusion

This tool provides robust programmatic access to Google Docs. When used by AI agents, it enables:
- Automated documentation workflows
- Dynamic report generation
- Content transformation pipelines
- Collaborative document maintenance

Always verify operations on test documents before modifying production content.
