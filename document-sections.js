/**
 * Parse Google Docs structure into sections based on headings
 */

/**
 * Extract document outline with sections
 * @param {Object} doc - Google Docs API document object
 * @returns {Array} Array of sections with hierarchy
 */
function parseDocumentSections(doc) {
  const content = doc.body.content;
  const sections = [];

  // Find all headings
  const headings = [];

  for (const element of content) {
    if (element.paragraph) {
      const style = element.paragraph.paragraphStyle;
      const namedStyleType = style?.namedStyleType;

      if (namedStyleType && namedStyleType.startsWith('HEADING_')) {
        const level = parseInt(namedStyleType.replace('HEADING_', ''));
        const text = extractTextFromParagraph(element.paragraph);

        headings.push({
          level: level,
          text: text,
          headingId: style.headingId,
          startIndex: element.startIndex,
          endIndex: element.endIndex
        });
      }
    }
  }

  // Calculate section boundaries
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeading = headings[i + 1];

    // Section ends at next heading of same or higher level (lower number)
    let sectionEndIndex;
    if (nextHeading) {
      // Find next heading at same or higher level
      let endHeadingIdx = i + 1;
      while (endHeadingIdx < headings.length && headings[endHeadingIdx].level > heading.level) {
        endHeadingIdx++;
      }

      if (endHeadingIdx < headings.length) {
        sectionEndIndex = headings[endHeadingIdx].startIndex;
      } else {
        // Last section goes to end of document
        sectionEndIndex = content[content.length - 1].endIndex;
      }
    } else {
      // Last heading, section goes to end
      sectionEndIndex = content[content.length - 1].endIndex;
    }

    sections.push({
      level: heading.level,
      title: heading.text,
      headingId: heading.headingId,
      headingStartIndex: heading.startIndex,
      headingEndIndex: heading.endIndex,
      contentStartIndex: heading.endIndex,
      contentEndIndex: sectionEndIndex,
      sectionStartIndex: heading.startIndex,
      sectionEndIndex: sectionEndIndex
    });
  }

  return sections;
}

/**
 * Extract text content from a paragraph
 */
function extractTextFromParagraph(paragraph) {
  if (!paragraph.elements) return '';

  return paragraph.elements
    .map(element => element.textRun?.content || '')
    .join('')
    .replace(/\n$/, ''); // Remove trailing newline
}

/**
 * Extract content from a specific section (without heading)
 */
function extractSectionContent(doc, section) {
  const content = doc.body.content;
  const elements = [];

  for (const element of content) {
    // Check if element is within section content range
    if (element.startIndex >= section.contentStartIndex &&
        element.startIndex < section.contentEndIndex) {
      elements.push(element);
    }
  }

  return elements;
}

/**
 * Format section content as readable text
 */
function formatSectionAsText(doc, section) {
  const elements = extractSectionContent(doc, section);
  const lines = [];

  for (const element of elements) {
    if (element.paragraph) {
      const text = extractTextFromParagraph(element.paragraph);
      if (text.trim()) {
        lines.push(text);
      }
    } else if (element.table) {
      lines.push('\n[Table]');
      const table = element.table;
      table.tableRows.forEach((row, rowIdx) => {
        const cells = row.tableCells.map(cell => {
          return cell.content[0]?.paragraph?.elements
            .map(e => e.textRun?.content || '')
            .join('')
            .trim() || '';
        });
        lines.push('  ' + cells.join(' | '));
      });
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Build hierarchical outline from flat sections
 */
function buildOutline(sections) {
  const outline = [];
  const stack = [];

  for (const section of sections) {
    // Pop stack until we find the parent level
    while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
      stack.pop();
    }

    const node = {
      ...section,
      children: []
    };

    if (stack.length === 0) {
      outline.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return outline;
}

/**
 * Print outline as indented tree
 */
function printOutline(sections, indent = 0) {
  const lines = [];

  for (const section of sections) {
    const prefix = '  '.repeat(indent);
    const levelIndicator = 'H' + section.level;
    const range = `[${section.sectionStartIndex}-${section.sectionEndIndex}]`;
    lines.push(`${prefix}${levelIndicator}: ${section.title} ${range}`);

    if (section.children && section.children.length > 0) {
      lines.push(...printOutline(section.children, indent + 1));
    }
  }

  return lines;
}

/**
 * Find section by title (case-insensitive partial match)
 */
function findSectionByTitle(sections, title) {
  const searchTitle = title.toLowerCase();

  for (const section of sections) {
    if (section.title.toLowerCase().includes(searchTitle)) {
      return section;
    }
  }

  return null;
}

/**
 * Generate delete request for section content (preserves heading)
 * @param {Object} section - Section object from parseDocumentSections
 * @returns {Object} Google Docs API deleteContentRange request
 */
function createDeleteSectionContentRequest(section) {
  // Only delete content, not the heading
  if (section.contentStartIndex >= section.contentEndIndex) {
    return null; // Empty section, nothing to delete
  }

  return {
    deleteContentRange: {
      range: {
        startIndex: section.contentStartIndex,
        endIndex: section.contentEndIndex - 1 // -1 to preserve paragraph boundary
      }
    }
  };
}

/**
 * Generate delete request for entire section (heading + content)
 * @param {Object} section - Section object from parseDocumentSections
 * @returns {Object} Google Docs API deleteContentRange request
 */
function createDeleteSectionRequest(section) {
  return {
    deleteContentRange: {
      range: {
        startIndex: section.sectionStartIndex,
        endIndex: section.sectionEndIndex - 1 // -1 to preserve paragraph boundary
      }
    }
  };
}

/**
 * Search for text in document
 * @param {Object} doc - Google Docs API document object
 * @param {String} query - Search query (case-insensitive)
 * @param {Object} section - Optional: limit search to specific section
 * @returns {Array} Array of matches with context
 */
function searchInDocument(doc, query, section = null) {
  const content = doc.body.content;
  const matches = [];
  const searchQuery = query.toLowerCase();

  let searchStartIndex = section ? section.sectionStartIndex : 0;
  let searchEndIndex = section ? section.sectionEndIndex : Infinity;

  for (const element of content) {
    if (element.paragraph) {
      // Skip if outside search range
      if (element.startIndex < searchStartIndex || element.startIndex >= searchEndIndex) {
        continue;
      }

      const text = extractTextFromParagraph(element.paragraph);
      const lowerText = text.toLowerCase();

      let index = 0;
      while ((index = lowerText.indexOf(searchQuery, index)) !== -1) {
        // Calculate actual document position
        const matchStart = element.startIndex + index;
        const matchEnd = matchStart + query.length;

        // Get context (20 chars before and after)
        const contextStart = Math.max(0, index - 20);
        const contextEnd = Math.min(text.length, index + query.length + 20);
        const context = text.substring(contextStart, contextEnd);

        matches.push({
          startIndex: matchStart,
          endIndex: matchEnd,
          text: text.substring(index, index + query.length),
          context: context,
          paragraphIndex: element.startIndex
        });

        index += query.length;
      }
    }
  }

  return matches;
}

module.exports = {
  parseDocumentSections,
  extractSectionContent,
  formatSectionAsText,
  buildOutline,
  printOutline,
  findSectionByTitle,
  createDeleteSectionContentRequest,
  createDeleteSectionRequest,
  searchInDocument
};
