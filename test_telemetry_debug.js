const fs = require('fs');
const path = require('path');

const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function extractFunction(code, name) {
  const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = regex.exec(code);
  if (!match) {
    throw new Error(`No se pudo encontrar la función ${name} en server.js`);
  }
  const startIndex = match.index;
  let braceCount = 1;
  let index = code.indexOf('{', startIndex) + 1;
  while (braceCount > 0 && index < code.length) {
    if (code[index] === '{') braceCount++;
    else if (code[index] === '}') braceCount--;
    index++;
  }
  return code.slice(startIndex, index);
}

const withTimeoutCode = extractFunction(serverCode, 'withTimeout');
const extractResponsePreviewCode = extractFunction(serverCode, 'extractResponsePreview');
const finalizeAdapterEventReliablyCode = extractFunction(serverCode, 'finalizeAdapterEventReliably');

console.log("=== DEBUG EXTRACTED FUNCTIONS ===");
console.log("withTimeoutCode:\n", withTimeoutCode.slice(-100));
console.log("extractResponsePreviewCode:\n", extractResponsePreviewCode.slice(-100));
console.log("finalizeAdapterEventReliablyCode:\n", finalizeAdapterEventReliablyCode.slice(-250));
