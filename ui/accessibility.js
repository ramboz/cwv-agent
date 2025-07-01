// Get URL parameters
const urlParams = new URLSearchParams(window.location.search);
const accessibilityReport = urlParams.get('accessibility');

// Copy from ../src/utils.js
const OUTPUT_DIR = '/.cache';

function getFilePrefix(urlString, deviceType, type) {
  return `${OUTPUT_DIR}/${urlString.replace('https://', '').replace(/[^A-Za-z0-9-]/g, '-').replace(/\//g, '--').replace(/(^-+|-+$)/, '')}.${deviceType}.${type}`
}

async function loadAccessibilityReport() {
  if (!accessibilityReport) {
    document.getElementById('report-content').innerHTML = `
      <div class="error">
        <h3>No accessibility report specified</h3>
        <p>Please provide an accessibility report URL parameter.</p>
        <p>Example: ?accessibility=/.cache/example.com.mobile.accessibility-report.json</p>
      </div>
    `;
    return;
  }

  try {
    const response = await fetch(accessibilityReport);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    let content;
    if (accessibilityReport.endsWith('.md')) {
      content = await response.text();
      displayAccessibilityReport({ content });
    } else {
      const data = await response.json();
      displayAccessibilityReport(data);
    }
  } catch (error) {
    console.error('Error loading accessibility report:', error);
    document.getElementById('report-content').innerHTML = `
      <div class="error">
        <h3>Error loading accessibility report</h3>
        <p>${error.message}</p>
        <p>Make sure the report file exists and is accessible.</p>
      </div>
    `;
  }
}

function displayAccessibilityReport(data) {
  const reportContent = document.getElementById('report-content');
  
  // Extract URL from the report path
  const urlMatch = accessibilityReport.match(/\.cache\/([^.]+)\.([^.]+)\.accessibility-report/);
  if (urlMatch) {
    const url = urlMatch[1].replace(/-/g, '.').replace(/--/g, '/');
    const deviceType = urlMatch[2];
    document.getElementById('url-info').textContent = `URL: ${url} (${deviceType})`;
  }

  // Extract only the markdown content
  let markdown;
  if (typeof data === 'string') {
    markdown = data;
  } else if (data.content) {
    markdown = data.content;
  } else {
    // Try to find the first string property in the object
    const firstString = Object.values(data).find(v => typeof v === 'string');
    markdown = firstString || JSON.stringify(data, null, 2);
  }
  const htmlContent = convertMarkdownToHtml(markdown);
  reportContent.innerHTML = htmlContent;
  
  // Add syntax highlighting to code blocks (optional, if you want to keep it)
  highlightCodeBlocks();
}

function convertMarkdownToHtml(markdown) {
  return marked.parse(markdown);
}

function highlightCodeBlocks() {
  const codeBlocks = document.querySelectorAll('.code-block code');
  codeBlocks.forEach(block => {
    // Simple syntax highlighting for HTML
    let html = block.innerHTML;
    
    // Highlight HTML tags
    html = html.replace(/(&lt;\/?)([a-zA-Z][a-zA-Z0-9]*)([^&]*?)(&gt;)/g, 
      '$1<span style="color: #ff6b6b;">$2</span>$3$4');
    
    // Highlight attributes
    html = html.replace(/([a-zA-Z-]+)=/g, 
      '<span style="color: #4ecdc4;">$1</span>=');
    
    // Highlight attribute values
    html = html.replace(/="([^"]*)"/g, 
      '="<span style="color: #ffe66d;">$1</span>"');
    
    block.innerHTML = html;
  });
}

// Load the report when the page loads
document.addEventListener('DOMContentLoaded', loadAccessibilityReport); 