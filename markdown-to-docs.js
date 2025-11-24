const { marked } = require('marked');

/**
 * Converts markdown to Google Docs API batch requests
 *
 * Tables require multi-pass processing:
 * 1. Insert table structure
 * 2. Read back document to get cell positions
 * 3. Populate cells with content
 */
class MarkdownToDocsConverter {
  constructor() {
    this.requests = [];
    this.tableInsertRequests = [];
    this.currentIndex = 1; // Docs API uses 1-based indexing
    this.tables = []; // Metadata about tables to populate later
  }

  /**
   * Main conversion method
   * @param {string} markdown - Markdown content to convert
   * @returns {Object} { contentRequests: Array, tableRequests: Array, tables: Array }
   */
  convert(markdown) {
    this.requests = [];
    this.tableInsertRequests = [];
    this.tables = [];
    this.currentIndex = 1;

    const tokens = marked.lexer(markdown);

    for (const token of tokens) {
      this.processToken(token);
    }

    return {
      contentRequests: this.requests,
      tableRequests: this.tableInsertRequests,
      tables: this.tables
    };
  }

  processToken(token) {
    switch (token.type) {
      case 'heading':
        this.addHeading(token);
        break;
      case 'paragraph':
        this.addParagraph(token);
        break;
      case 'list':
        this.addList(token);
        break;
      case 'code':
        this.addCodeBlock(token);
        break;
      case 'table':
        this.addTable(token);
        break;
      case 'space':
        // Skip empty lines
        break;
      default:
        console.warn(`Unsupported token type: ${token.type}`);
    }
  }

  addHeading(token) {
    const text = this.extractPlainText(token.tokens) + '\n';
    const startIndex = this.currentIndex;

    // Insert text
    this.requests.push({
      insertText: {
        location: { index: this.currentIndex },
        text: text
      }
    });

    this.currentIndex += text.length;

    // Apply heading style
    const headingLevel = `HEADING_${token.depth}`;
    this.requests.push({
      updateParagraphStyle: {
        range: {
          startIndex: startIndex,
          endIndex: this.currentIndex - 1
        },
        paragraphStyle: {
          namedStyleType: headingLevel
        },
        fields: 'namedStyleType'
      }
    });

    // Apply inline formatting (bold, italic, links)
    this.applyInlineFormatting(token.tokens, startIndex);
  }

  addParagraph(token) {
    const text = this.extractPlainText(token.tokens) + '\n';
    const startIndex = this.currentIndex;

    // Insert text
    this.requests.push({
      insertText: {
        location: { index: this.currentIndex },
        text: text
      }
    });

    this.currentIndex += text.length;

    // Apply inline formatting
    this.applyInlineFormatting(token.tokens, startIndex);
  }

  addList(token) {
    const isOrdered = token.ordered;

    for (const item of token.items) {
      const text = this.extractPlainText(item.tokens) + '\n';
      const startIndex = this.currentIndex;

      // Insert text
      this.requests.push({
        insertText: {
          location: { index: this.currentIndex },
          text: text
        }
      });

      this.currentIndex += text.length;

      // Apply list formatting
      this.requests.push({
        createParagraphBullets: {
          range: {
            startIndex: startIndex,
            endIndex: this.currentIndex - 1
          },
          bulletPreset: isOrdered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE'
        }
      });

      // Apply inline formatting
      this.applyInlineFormatting(item.tokens, startIndex);
    }
  }

  addCodeBlock(token) {
    const text = token.text + '\n\n';
    const startIndex = this.currentIndex;

    // Insert code text
    this.requests.push({
      insertText: {
        location: { index: this.currentIndex },
        text: text
      }
    });

    this.currentIndex += text.length;

    // Apply monospace font and light gray background
    this.requests.push({
      updateTextStyle: {
        range: {
          startIndex: startIndex,
          endIndex: this.currentIndex - 2
        },
        textStyle: {
          weightedFontFamily: {
            fontFamily: 'Courier New'
          },
          fontSize: {
            magnitude: 10,
            unit: 'PT'
          },
          backgroundColor: {
            color: {
              rgbColor: {
                red: 0.95,
                green: 0.95,
                blue: 0.95
              }
            }
          }
        },
        fields: 'weightedFontFamily,fontSize,backgroundColor'
      }
    });
  }

  addTable(token) {
    const rows = token.rows.length + 1; // +1 for header
    const cols = token.header.length;
    const tableStartIndex = this.currentIndex;

    // Insert a placeholder paragraph that will be replaced with table
    const placeholder = `[TABLE:${rows}x${cols}]\n`;
    this.requests.push({
      insertText: {
        location: { index: tableStartIndex },
        text: placeholder
      }
    });
    this.currentIndex += placeholder.length;

    // Collect cell data for later population
    const cellData = [];

    // Header cells (bold)
    for (let col = 0; col < cols; col++) {
      cellData.push({
        row: 0,
        col: col,
        text: this.extractPlainText(token.header[col].tokens),
        bold: true
      });
    }

    // Data cells
    for (let row = 0; row < token.rows.length; row++) {
      for (let col = 0; col < cols; col++) {
        cellData.push({
          row: row + 1,
          col: col,
          text: this.extractPlainText(token.rows[row][col].tokens),
          bold: false
        });
      }
    }

    // Store table metadata for later insertion and population
    this.tables.push({
      placeholderIndex: tableStartIndex,
      placeholderLength: placeholder.length,
      rows: rows,
      cols: cols,
      cellData: cellData
    });

    // Queue table insertion request (will be applied after placeholder is removed)
    this.tableInsertRequests.push({
      placeholderIndex: tableStartIndex,
      placeholderLength: placeholder.length,
      rows: rows,
      cols: cols
    });
  }

  applyInlineFormatting(tokens, startOffset) {
    if (!tokens) return;

    let currentOffset = 0;

    for (const token of tokens) {
      // Calculate actual text length by extracting it (handles nested tokens correctly)
      let length;
      if (token.type === 'strong' || token.type === 'em' || token.type === 'link') {
        // For formatting tokens, extract text from children to get accurate length
        length = this.extractPlainText(token.tokens).length;
      } else if (token.type === 'text' || token.type === 'codespan') {
        length = token.text ? token.text.length : 0;
      } else {
        length = 0;
      }

      const tokenStart = startOffset + currentOffset;
      const tokenEnd = tokenStart + length;

      if (token.type === 'strong') {
        this.requests.push({
          updateTextStyle: {
            range: {
              startIndex: tokenStart,
              endIndex: tokenEnd
            },
            textStyle: {
              bold: true
            },
            fields: 'bold'
          }
        });
      } else if (token.type === 'em') {
        this.requests.push({
          updateTextStyle: {
            range: {
              startIndex: tokenStart,
              endIndex: tokenEnd
            },
            textStyle: {
              italic: true
            },
            fields: 'italic'
          }
        });
      } else if (token.type === 'link') {
        this.requests.push({
          updateTextStyle: {
            range: {
              startIndex: tokenStart,
              endIndex: tokenEnd
            },
            textStyle: {
              link: {
                url: token.href
              }
            },
            fields: 'link'
          }
        });
      } else if (token.type === 'codespan') {
        this.requests.push({
          updateTextStyle: {
            range: {
              startIndex: tokenStart,
              endIndex: tokenEnd
            },
            textStyle: {
              weightedFontFamily: {
                fontFamily: 'Courier New'
              },
              backgroundColor: {
                color: {
                  rgbColor: {
                    red: 0.95,
                    green: 0.95,
                    blue: 0.95
                  }
                }
              }
            },
            fields: 'weightedFontFamily,backgroundColor'
          }
        });
      }

      // Recursively process nested tokens
      if (token.tokens && token.tokens.length > 0) {
        this.applyInlineFormatting(token.tokens, tokenStart);
      }

      currentOffset += length;
    }
  }

  extractPlainText(tokens) {
    if (!tokens) return '';

    let text = '';
    for (const token of tokens) {
      if (token.type === 'strong' || token.type === 'em' || token.type === 'link') {
        // Formatting tokens - recursively extract from children
        text += this.extractPlainText(token.tokens);
      } else if (token.tokens && token.tokens.length > 0) {
        // Token has nested tokens (e.g., list item text with inline formatting)
        // Process children instead of using raw token.text
        text += this.extractPlainText(token.tokens);
      } else if (token.type === 'text' || token.type === 'codespan') {
        text += token.text || '';
      } else if (token.type === 'space') {
        text += ' ';
      } else if (token.text) {
        text += token.text;
      }
    }
    return text;
  }
}

module.exports = MarkdownToDocsConverter;
