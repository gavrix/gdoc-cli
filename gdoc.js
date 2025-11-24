#!/usr/bin/env node

const { Command } = require('commander');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const os = require('os');
const MarkdownToDocsConverter = require('./markdown-to-docs');
const {
  parseDocumentSections,
  buildOutline,
  printOutline,
  findSectionByTitle,
  formatSectionAsText,
  createDeleteSectionContentRequest,
  createDeleteSectionRequest,
  searchInDocument
} = require('./document-sections');

// Configuration - use user home directory for credentials
const AUTH_DIR = path.join(os.homedir(), '.gdoc');
const OAUTH2_CREDENTIALS = path.join(AUTH_DIR, 'credentials.json');
const OAUTH2_TOKEN = path.join(AUTH_DIR, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/documents'];

/**
 * Start local server to capture OAuth2 redirect
 */
async function getAuthCodeViaLocalServer(authUrl) {
  const http = require('http');
  const { URL } = require('url');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost:3000');

        if (url.pathname === '/') {
          const code = url.searchParams.get('code');

          if (code) {
            // Success! Send response to browser
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('You can now safely close this window and return to the terminal.');

            server.close();
            resolve(code);
          } else {
            // Error in redirect
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Error: No authorization code received');
            server.close();
            reject(new Error('No authorization code in redirect'));
          }
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error processing request');
        server.close();
        reject(error);
      }
    });

    server.listen(3000, () => {
      console.log('');
      console.log('🔐 OAuth2 Authentication Required');
      console.log('');
      console.log('Opening browser for authentication...');
      console.log('If browser doesn\'t open, visit:');
      console.log('');
      console.log(authUrl);
      console.log('');
      console.log('Waiting for authorization...');

      // Try to open browser automatically
      const open = require('child_process').exec;
      const platform = process.platform;

      let cmd;
      if (platform === 'darwin') cmd = `open "${authUrl}"`;
      else if (platform === 'win32') cmd = `start "${authUrl}"`;
      else cmd = `xdg-open "${authUrl}"`;

      open(cmd, (error) => {
        if (error) {
          console.log('(Could not open browser automatically)');
        }
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timeout'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Creates OAuth2 client and handles authentication flow
 */
async function createOAuth2Client() {
  if (!fs.existsSync(OAUTH2_CREDENTIALS)) {
    throw new Error(`OAuth2 credentials not found at: ${OAUTH2_CREDENTIALS}`);
  }

  const credentials = JSON.parse(fs.readFileSync(OAUTH2_CREDENTIALS, 'utf-8'));
  const { client_id, client_secret } = credentials.installed;

  // Use localhost:3000 as redirect URI
  const redirectUri = 'http://localhost:3000';

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirectUri
  );

  // Check if we have a token already
  if (fs.existsSync(OAUTH2_TOKEN)) {
    const token = JSON.parse(fs.readFileSync(OAUTH2_TOKEN, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // Need to authenticate - generate auth URL
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  // Start local server and get code
  const code = await getAuthCodeViaLocalServer(authUrl);

  // Exchange code for tokens
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Ensure auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  // Save tokens for future use
  fs.writeFileSync(OAUTH2_TOKEN, JSON.stringify(tokens, null, 2));
  console.log('');
  console.log('✓ Authentication successful!');
  console.log('✓ Tokens saved to:', OAUTH2_TOKEN);
  console.log('');

  return oAuth2Client;
}

/**
 * Creates an authenticated Google Docs client
 */
async function createDocsClient() {
  // Check if user is authenticated
  if (!fs.existsSync(OAUTH2_TOKEN)) {
    console.error('');
    console.error('❌ Not authenticated');
    console.error('');
    console.error('Please run authentication first:');
    console.error('');
    console.error('  gdoc auth');
    console.error('');
    process.exit(1);
  }

  const authClient = await createOAuth2Client();
  return google.docs({ version: 'v1', auth: authClient });
}

/**
 * Parse JSON from string or file
 */
function parseJSON(value) {
  // Check if it's a file path
  if (value.startsWith('@')) {
    const filePath = value.slice(1);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return JSON.parse(value);
}

/**
 * Pretty print JSON output
 */
function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Create a new Google Doc
 */
async function createDocument(docs, title) {
  const response = await docs.documents.create({
    requestBody: {
      title: title,
    },
  });
  return response.data;
}

/**
 * Clear all content from a document
 */
async function clearDocument(docs, documentId) {
  const doc = await docs.documents.get({ documentId });
  const endIndex = doc.data.body.content[doc.data.body.content.length - 1].endIndex;

  if (endIndex > 2) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{
          deleteContentRange: {
            range: {
              startIndex: 1,
              endIndex: endIndex - 1,
            },
          },
        }],
      },
    });
  }
}

/**
 * Apply batch requests to a document
 */
async function updateDocument(docs, documentId, requests) {
  if (requests.length === 0) {
    return;
  }

  const response = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: requests,
    },
  });

  return response.data;
}

/**
 * Replace placeholder text with table structures
 * Process one table at a time to avoid cross-table index drift
 */
async function insertTables(docs, documentId, tableRequests) {
  if (tableRequests.length === 0) {
    return;
  }

  // Process each table separately to get fresh indices
  for (const tableReq of tableRequests) {
    const doc = await docs.documents.get({ documentId });
    const content = doc.data.body.content;

    let placeholderStart = null;
    let placeholderEnd = null;

    for (const element of content) {
      if (element.paragraph) {
        for (const textElement of element.paragraph.elements) {
          if (textElement.textRun && textElement.textRun.content.includes(`[TABLE:${tableReq.rows}x${tableReq.cols}]`)) {
            placeholderStart = textElement.startIndex;
            placeholderEnd = textElement.endIndex;
            break;
          }
        }
      }
      if (placeholderStart !== null) break;
    }

    if (placeholderStart === null) {
      console.warn(`Could not find placeholder for table ${tableReq.rows}x${tableReq.cols}`);
      continue;
    }

    const requests = [
      {
        deleteContentRange: {
          range: {
            startIndex: placeholderStart,
            endIndex: placeholderEnd - 1
          }
        }
      },
      {
        insertTable: {
          location: { index: placeholderStart },
          rows: tableReq.rows,
          columns: tableReq.cols
        }
      }
    ];

    await updateDocument(docs, documentId, requests);
  }
}

/**
 * Find tables in document and populate them with content
 * Optimized: Fetch fresh doc per table + single batchUpdate per table
 * This avoids cross-table index drift (O(tables) API calls vs O(cells))
 */
async function populateTables(docs, documentId, tableMetadata) {
  if (tableMetadata.length === 0) {
    return;
  }

  // Process each table with a single batch request
  for (let tableIdx = 0; tableIdx < tableMetadata.length; tableIdx++) {
    // Fetch fresh document to get current structure (accounts for previous table insertions)
    const doc = await docs.documents.get({ documentId });
    const content = doc.data.body.content;
    const tables = content.filter(element => element.table);

    if (tableIdx >= tables.length) {
      console.warn(`Warning: Table ${tableIdx} not found in document (only ${tables.length} tables exist)`);
      break;
    }

    const metadata = tableMetadata[tableIdx];
    const table = tables[tableIdx].table;

    // First, collect all cell info with their base indices
    const cellOperations = [];

    for (const cellInfo of metadata.cellData) {
      const { row, col, text, bold } = cellInfo;

      // Validate cell coordinates
      if (row >= table.tableRows.length || col >= table.tableRows[row].tableCells.length) {
        console.warn(`Cell [${row}][${col}] out of bounds in table ${tableIdx}`);
        continue;
      }

      const cell = table.tableRows[row].tableCells[col];

      if (!cell.content || cell.content.length === 0) {
        console.warn(`Cell [${row}][${col}] has no content in table ${tableIdx}`);
        continue;
      }

      const paragraph = cell.content[0].paragraph;
      if (!paragraph || !paragraph.elements || paragraph.elements.length === 0) {
        console.warn(`Cell [${row}][${col}] has no paragraph in table ${tableIdx}`);
        continue;
      }

      // Safety check: skip cells that already have content
      const existingText = paragraph.elements
        .map(el => el.textRun?.content || '')
        .join('')
        .trim();

      if (existingText.length > 0) {
        console.warn(`Cell [${row}][${col}] already contains text: "${existingText}" - skipping`);
        continue;
      }

      const textInsertIndex = paragraph.elements[0].startIndex;

      if (text && text.trim().length > 0) {
        // Store operation info for later processing
        cellOperations.push({
          row,
          col,
          baseIndex: textInsertIndex,
          text,
          bold
        });
      }
    }

    // Sort by baseIndex to ensure ascending order (don't rely on row-major assumption)
    cellOperations.sort((a, b) => a.baseIndex - b.baseIndex);

    // Now build batch requests with cumulative offset adjustment
    const requests = [];
    let cumulativeOffset = 0;

    for (const op of cellOperations) {
      const adjustedIndex = op.baseIndex + cumulativeOffset;

      // Insert text
      requests.push({
        insertText: {
          location: { index: adjustedIndex },
          text: op.text
        }
      });

      // Apply bold style if needed (executes sequentially after insert)
      if (op.bold) {
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: adjustedIndex,
              endIndex: adjustedIndex + op.text.length
            },
            textStyle: {
              bold: true
            },
            fields: 'bold'
          }
        });
      }

      // Update cumulative offset for next cell
      cumulativeOffset += op.text.length;
    }

    // Execute all cell operations for this table in a single batchUpdate
    if (requests.length > 0) {
      await updateDocument(docs, documentId, requests);
    }
  }
}

// Create CLI
const program = new Command();

program
  .name('gdoc')
  .description('Direct Google Docs API CLI')
  .version('1.0.0');

// documents.get
program
  .command('documents.get')
  .description('Get a document by ID')
  .requiredOption('--documentId <id>', 'Document ID')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const response = await docs.documents.get({
        documentId: options.documentId
      });
      output(response.data);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// documents.create
program
  .command('documents.create')
  .description('Create a new document')
  .option('--title <title>', 'Document title', 'Untitled')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const response = await docs.documents.create({
        requestBody: {
          title: options.title
        }
      });
      output(response.data);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// documents.batchUpdate
program
  .command('documents.batchUpdate')
  .description('Batch update a document')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--requests <json>', 'JSON array of requests or @file.json')
  .option('--writeControl <json>', 'WriteControl JSON (optional)')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();

      const requestBody = {
        requests: parseJSON(options.requests)
      };

      if (options.writeControl) {
        requestBody.writeControl = parseJSON(options.writeControl);
      }

      const response = await docs.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: requestBody
      });
      output(response.data);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// markdown - Convert markdown to Google Doc
program
  .command('markdown')
  .description('Convert markdown file to Google Doc')
  .requiredOption('-f, --file <path>', 'Markdown file path')
  .option('-d, --docId <id>', 'Document ID to update (creates new if omitted)')
  .option('-t, --title <title>', 'Document title (for new documents)')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();

      // Read markdown file
      if (!fs.existsSync(options.file)) {
        throw new Error(`File not found: ${options.file}`);
      }

      const markdown = fs.readFileSync(options.file, 'utf-8');

      // Convert markdown to Docs API requests
      const converter = new MarkdownToDocsConverter();
      const { contentRequests, tableRequests, tables } = converter.convert(markdown);

      let docId = options.docId;
      let docUrl;

      if (docId) {
        // Update existing document
        await clearDocument(docs, docId);
        await updateDocument(docs, docId, contentRequests);

        if (tableRequests.length > 0) {
          await insertTables(docs, docId, tableRequests);
        }

        if (tables.length > 0) {
          await populateTables(docs, docId, tables);
        }

        docUrl = `https://docs.google.com/document/d/${docId}/edit`;
      } else {
        // Create new document
        const title = options.title || path.basename(options.file, path.extname(options.file));
        const doc = await createDocument(docs, title);
        docId = doc.documentId;
        docUrl = `https://docs.google.com/document/d/${docId}/edit`;

        await updateDocument(docs, docId, contentRequests);

        if (tableRequests.length > 0) {
          await insertTables(docs, docId, tableRequests);
        }

        if (tables.length > 0) {
          await populateTables(docs, docId, tables);
        }
      }

      output({
        success: true,
        documentId: docId,
        url: docUrl,
        message: 'Markdown converted to Google Doc'
      });
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// list-sections - Show document outline
program
  .command('list-sections')
  .description('List all sections in a document (outline view)')
  .requiredOption('--documentId <id>', 'Document ID')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const doc = await docs.documents.get({ documentId: options.documentId });

      const sections = parseDocumentSections(doc.data);
      const outline = buildOutline(sections);

      if (options.json) {
        output(outline);
      } else {
        console.log(`Document: ${doc.data.title}`);
        console.log('');
        const lines = printOutline(outline);
        lines.forEach(line => console.log(line));
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// read-section - Extract content from a specific section
program
  .command('read-section')
  .description('Read content from a specific section')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--title <title>', 'Section title (partial match, case-insensitive)')
  .option('--json', 'Output raw section data as JSON')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const doc = await docs.documents.get({ documentId: options.documentId });

      const sections = parseDocumentSections(doc.data);
      const section = findSectionByTitle(sections, options.title);

      if (!section) {
        console.error(`Section not found: ${options.title}`);
        console.error('');
        console.error('Available sections:');
        sections.forEach(s => console.error(`  - ${s.title}`));
        process.exit(1);
      }

      if (options.json) {
        output({
          section: section,
          content: formatSectionAsText(doc.data, section)
        });
      } else {
        console.log(`Section: ${section.title} (H${section.level})`);
        console.log(`Range: ${section.sectionStartIndex}-${section.sectionEndIndex}`);
        console.log('');
        console.log('Content:');
        console.log('─'.repeat(60));
        console.log(formatSectionAsText(doc.data, section));
        console.log('─'.repeat(60));
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// update-section - Replace section content from markdown
program
  .command('update-section')
  .description('Update a section with new content from markdown')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--title <title>', 'Section title to update')
  .requiredOption('-f, --file <path>', 'Markdown file with new content')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();

      // Read markdown file
      if (!fs.existsSync(options.file)) {
        throw new Error(`File not found: ${options.file}`);
      }
      const markdown = fs.readFileSync(options.file, 'utf-8');

      // Get document and find section
      const doc = await docs.documents.get({ documentId: options.documentId });
      const sections = parseDocumentSections(doc.data);
      const section = findSectionByTitle(sections, options.title);

      if (!section) {
        console.error(`Section not found: ${options.title}`);
        console.error('');
        console.error('Available sections:');
        sections.forEach(s => console.error(`  - ${s.title}`));
        process.exit(1);
      }

      console.log(`Updating section: ${section.title} (H${section.level})`);
      console.log(`Range: ${section.sectionStartIndex}-${section.sectionEndIndex}`);

      // Step 1: Delete old content (preserve heading)
      const deleteRequest = createDeleteSectionContentRequest(section);
      if (deleteRequest) {
        await updateDocument(docs, options.documentId, [deleteRequest]);
        console.log('✓ Old content deleted');
      } else {
        console.log('✓ Section was empty');
      }

      // Step 2: Convert markdown to API requests
      const converter = new MarkdownToDocsConverter();
      const { contentRequests, tableRequests, tables } = converter.convert(markdown);

      // Adjust insertion index (insert right after heading)
      const insertIndex = section.headingEndIndex;
      const indexOffset = insertIndex - 1; // Converter starts at index 1

      contentRequests.forEach(req => {
        if (req.insertText) {
          // Adjust insertText index to maintain relative positions
          req.insertText.location.index += indexOffset;
        } else if (req.updateTextStyle) {
          // Adjust style application indices
          req.updateTextStyle.range.startIndex += indexOffset;
          req.updateTextStyle.range.endIndex += indexOffset;
        } else if (req.updateParagraphStyle) {
          // Adjust paragraph style indices
          req.updateParagraphStyle.range.startIndex += indexOffset;
          req.updateParagraphStyle.range.endIndex += indexOffset;
        } else if (req.createParagraphBullets) {
          // Adjust bullet list indices
          req.createParagraphBullets.range.startIndex += indexOffset;
          req.createParagraphBullets.range.endIndex += indexOffset;
        }
      });

      // Step 3: Insert new content
      await updateDocument(docs, options.documentId, contentRequests);
      console.log('✓ New content inserted');

      // Step 4: Handle tables if any
      if (tableRequests.length > 0) {
        await insertTables(docs, options.documentId, tableRequests);
        console.log('✓ Table structures inserted');
      }

      if (tables.length > 0) {
        await populateTables(docs, options.documentId, tables);
        console.log('✓ Tables populated');
      }

      console.log('');
      console.log(`✓ Section "${section.title}" updated successfully`);
      console.log(`View: https://docs.google.com/document/d/${options.documentId}/edit`);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// append-to-section - Add content to end of section
program
  .command('append-to-section')
  .description('Append content to the end of a section')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--title <title>', 'Section title to append to')
  .requiredOption('-f, --file <path>', 'Markdown file with content to append')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();

      if (!fs.existsSync(options.file)) {
        throw new Error(`File not found: ${options.file}`);
      }
      const markdown = fs.readFileSync(options.file, 'utf-8');

      const doc = await docs.documents.get({ documentId: options.documentId });
      const sections = parseDocumentSections(doc.data);
      const section = findSectionByTitle(sections, options.title);

      if (!section) {
        console.error(`Section not found: ${options.title}`);
        process.exit(1);
      }

      console.log(`Appending to section: ${section.title}`);

      // Convert markdown
      const converter = new MarkdownToDocsConverter();
      const { contentRequests, tableRequests, tables } = converter.convert(markdown);

      // Insert at end of section (before next heading)
      const insertIndex = section.contentEndIndex;
      const indexOffset = insertIndex - 1;

      contentRequests.forEach(req => {
        if (req.insertText) {
          // Adjust insertText index to maintain relative positions
          req.insertText.location.index += indexOffset;
        } else if (req.updateTextStyle) {
          req.updateTextStyle.range.startIndex += indexOffset;
          req.updateTextStyle.range.endIndex += indexOffset;
        } else if (req.updateParagraphStyle) {
          req.updateParagraphStyle.range.startIndex += indexOffset;
          req.updateParagraphStyle.range.endIndex += indexOffset;
        } else if (req.createParagraphBullets) {
          req.createParagraphBullets.range.startIndex += indexOffset;
          req.createParagraphBullets.range.endIndex += indexOffset;
        }
      });

      await updateDocument(docs, options.documentId, contentRequests);
      console.log('✓ Content appended');

      if (tableRequests.length > 0) {
        await insertTables(docs, options.documentId, tableRequests);
        await populateTables(docs, options.documentId, tables);
        console.log('✓ Tables added');
      }

      console.log(`✓ Content appended to "${section.title}"`);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// delete-section - Remove entire section
program
  .command('delete-section')
  .description('Delete an entire section (heading + content)')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--title <title>', 'Section title to delete')
  .option('--confirm', 'Skip confirmation prompt')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const doc = await docs.documents.get({ documentId: options.documentId });
      const sections = parseDocumentSections(doc.data);
      const section = findSectionByTitle(sections, options.title);

      if (!section) {
        console.error(`Section not found: ${options.title}`);
        process.exit(1);
      }

      console.log(`Section to delete: ${section.title} (H${section.level})`);
      console.log(`Range: ${section.sectionStartIndex}-${section.sectionEndIndex}`);

      if (!options.confirm) {
        console.error('');
        console.error('⚠️  This will permanently delete the section.');
        console.error('Add --confirm flag to proceed.');
        process.exit(1);
      }

      const deleteRequest = createDeleteSectionRequest(section);
      await updateDocument(docs, options.documentId, [deleteRequest]);

      console.log(`✓ Section "${section.title}" deleted`);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// insert-section - Add new section before/after existing
program
  .command('insert-section')
  .description('Insert a new section before or after an existing section')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--title <title>', 'New section title')
  .requiredOption('--level <level>', 'Heading level (1-6)', parseInt)
  .requiredOption('-f, --file <path>', 'Markdown file with section content')
  .option('--before <section>', 'Insert before this section')
  .option('--after <section>', 'Insert after this section')
  .action(async (options) => {
    try {
      if (!options.before && !options.after) {
        console.error('Error: Must specify either --before or --after');
        process.exit(1);
      }

      const docs = await createDocsClient();

      if (!fs.existsSync(options.file)) {
        throw new Error(`File not found: ${options.file}`);
      }
      const markdown = fs.readFileSync(options.file, 'utf-8');

      const doc = await docs.documents.get({ documentId: options.documentId });
      const sections = parseDocumentSections(doc.data);

      const targetTitle = options.before || options.after;
      const targetSection = findSectionByTitle(sections, targetTitle);

      if (!targetSection) {
        console.error(`Section not found: ${targetTitle}`);
        process.exit(1);
      }

      // Determine insertion point
      const insertIndex = options.before
        ? targetSection.sectionStartIndex
        : targetSection.sectionEndIndex;

      console.log(`Inserting "${options.title}" (H${options.level}) ${options.before ? 'before' : 'after'} "${targetSection.title}"`);

      // Create heading
      const headingText = options.title + '\n';
      const headingRequest = {
        insertText: {
          location: { index: insertIndex },
          text: headingText
        }
      };

      await updateDocument(docs, options.documentId, [headingRequest]);
      console.log('✓ Heading inserted');

      // Apply heading style
      const headingStyleRequest = {
        updateParagraphStyle: {
          range: {
            startIndex: insertIndex,
            endIndex: insertIndex + headingText.length - 1
          },
          paragraphStyle: {
            namedStyleType: `HEADING_${options.level}`
          },
          fields: 'namedStyleType'
        }
      };

      await updateDocument(docs, options.documentId, [headingStyleRequest]);
      console.log('✓ Heading styled');

      // Insert content
      const converter = new MarkdownToDocsConverter();
      const { contentRequests, tableRequests, tables } = converter.convert(markdown);

      const contentInsertIndex = insertIndex + headingText.length;
      const indexOffset = contentInsertIndex - 1;

      contentRequests.forEach(req => {
        if (req.insertText) {
          // Adjust insertText index to maintain relative positions
          req.insertText.location.index += indexOffset;
        } else if (req.updateTextStyle) {
          req.updateTextStyle.range.startIndex += indexOffset;
          req.updateTextStyle.range.endIndex += indexOffset;
        } else if (req.updateParagraphStyle) {
          req.updateParagraphStyle.range.startIndex += indexOffset;
          req.updateParagraphStyle.range.endIndex += indexOffset;
        } else if (req.createParagraphBullets) {
          req.createParagraphBullets.range.startIndex += indexOffset;
          req.createParagraphBullets.range.endIndex += indexOffset;
        }
      });

      await updateDocument(docs, options.documentId, contentRequests);
      console.log('✓ Content inserted');

      if (tableRequests.length > 0) {
        await insertTables(docs, options.documentId, tableRequests);
        await populateTables(docs, options.documentId, tables);
        console.log('✓ Tables added');
      }

      console.log(`✓ Section "${options.title}" inserted`);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// search - Find text in document
program
  .command('search')
  .description('Search for text in document')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--query <text>', 'Text to search for')
  .option('--section <title>', 'Limit search to specific section')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const doc = await docs.documents.get({ documentId: options.documentId });

      let section = null;
      if (options.section) {
        const sections = parseDocumentSections(doc.data);
        section = findSectionByTitle(sections, options.section);
        if (!section) {
          console.error(`Section not found: ${options.section}`);
          process.exit(1);
        }
      }

      const matches = searchInDocument(doc.data, options.query, section);

      if (options.json) {
        output(matches);
      } else {
        if (matches.length === 0) {
          console.log(`No matches found for "${options.query}"`);
        } else {
          console.log(`Found ${matches.length} match(es) for "${options.query}"`);
          console.log('');

          matches.forEach((match, idx) => {
            console.log(`${idx + 1}. [${match.startIndex}-${match.endIndex}]`);
            console.log(`   ...${match.context}...`);
            console.log('');
          });
        }
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// replace - Find and replace text
program
  .command('replace')
  .description('Find and replace text in document')
  .requiredOption('--documentId <id>', 'Document ID')
  .requiredOption('--find <text>', 'Text to find')
  .requiredOption('--replace <text>', 'Replacement text')
  .option('--section <title>', 'Limit replacement to specific section')
  .option('--preview', 'Preview changes without applying')
  .action(async (options) => {
    try {
      const docs = await createDocsClient();
      const doc = await docs.documents.get({ documentId: options.documentId });

      let section = null;
      if (options.section) {
        const sections = parseDocumentSections(doc.data);
        section = findSectionByTitle(sections, options.section);
        if (!section) {
          console.error(`Section not found: ${options.section}`);
          process.exit(1);
        }
      }

      const matches = searchInDocument(doc.data, options.find, section);

      if (matches.length === 0) {
        console.log(`No matches found for "${options.find}"`);
        process.exit(0);
      }

      console.log(`Found ${matches.length} match(es)`);
      console.log('');

      if (options.preview) {
        console.log('Preview of changes:');
        console.log('');
        matches.forEach((match, idx) => {
          const before = match.context.replace(options.find, `[${options.find}]`);
          const after = match.context.replace(options.find, `[${options.replace}]`);
          console.log(`${idx + 1}. Before: ...${before}...`);
          console.log(`   After:  ...${after}...`);
          console.log('');
        });
        console.log('Run without --preview to apply changes');
      } else {
        // Apply replacements in reverse order to avoid index shifting
        const replacements = matches.reverse().map(match => ({
          deleteContentRange: {
            range: {
              startIndex: match.startIndex,
              endIndex: match.endIndex
            }
          }
        }));

        const insertions = matches.map(match => ({
          insertText: {
            location: { index: match.startIndex },
            text: options.replace
          }
        }));

        // Apply all replacements
        await updateDocument(docs, options.documentId, [...replacements, ...insertions]);
        console.log(`✓ Replaced ${matches.length} occurrence(s)`);
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// auth - Authenticate with OAuth2
program
  .command('auth')
  .description('Authenticate with OAuth2')
  .action(async () => {
    try {
      // Remove existing token to force re-auth
      if (fs.existsSync(OAUTH2_TOKEN)) {
        fs.unlinkSync(OAUTH2_TOKEN);
        console.log('✓ Removed existing OAuth2 token');
      }

      // Ensure auth directory exists
      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }

      // Check credentials exist
      if (!fs.existsSync(OAUTH2_CREDENTIALS)) {
        console.error('Error: OAuth2 credentials not found');
        console.error(`Expected at: ${OAUTH2_CREDENTIALS}`);
        console.error('');
        console.error('Please download OAuth2 credentials from Google Cloud Console:');
        console.error('1. Go to https://console.cloud.google.com/apis/credentials');
        console.error('2. Create OAuth2 Client ID (Desktop app)');
        console.error(`3. Download JSON and save as ${OAUTH2_CREDENTIALS}`);
        console.error('');
        console.error('See SETUP.md for detailed instructions.');
        process.exit(1);
      }

      console.log('Starting OAuth2 authentication...');
      console.log('');

      // Trigger authentication
      await createOAuth2Client();

      console.log('✓ Authentication complete!');
      console.log('');
      console.log('You can now use gdoc commands.');
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();
