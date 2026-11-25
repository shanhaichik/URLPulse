/// <reference types="vite/client" />

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { validateCatalog, type Catalog } from '../src/shared/i18n/index.js';
import { diagnosticReference } from '../src/shared/i18n/diagnostics.js';

const modules = import.meta.glob<Record<string, unknown>>('../src/shared/i18n/locales/**/*.ts', { eager: true });
const sources = import.meta.glob<string>('../src/**/*.{ts,tsx,cts}', { eager: true, query: '?raw', import: 'default' });
const syntax = Object.entries(sources).map(([path, content]) => ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true));
const renderer = syntax.filter(file => file.fileName.startsWith('../src/client/') && file.fileName.endsWith('.tsx'));
const catalogs = Object.entries(modules).flatMap(([path, module]) =>
  Object.entries(module).filter(([, value]) => value !== null && typeof value === 'object')
    .map(([name, catalog]) => ({ path, name, catalog: catalog as Catalog })));

function isLocaleAutonym(node: ts.Node): boolean {
  if (!ts.isJsxText(node) || !ts.isJsxElement(node.parent)) return false;
  const { tagName, attributes } = node.parent.openingElement;
  if (!ts.isIdentifier(tagName) || tagName.text !== 'option') return false;
  const hasAttribute = (name: string, value: string) => attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === name &&
    !!attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === value);
  return (node.text.trim() === 'Русский' && hasAttribute('value', 'ru-RU') && hasAttribute('lang', 'ru'))
    || (node.text.trim() === 'English' && hasAttribute('value', 'en-US') && hasAttribute('lang', 'en'));
}

const visibleAttributes = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'alt', 'caption', 'label', 'placeholder', 'title']);
const technicalValues = new Set([
  'URL', 'HTTP', 'HTTPS', 'TLS', 'SMTP', 'STARTTLS', 'Content-Type', 'Content-Length', 'Accept-Language', 'X-API-Key',
  'example.org', '/catalog/', 'https://example.org/sitemap.xml', 'https://example.com/sitemap.xml',
  'https://example.com/', 'https://example.com:8443', 'https://proxy.example.com:8443', 'smtp.example.com', 'name@example.com',
  'https://example.com/\nhttps://example.com/api/health',
]);

function hardcodedCopy(ast: ts.SourceFile) {
  const issues: string[] = [];
  function check(node: ts.Node) {
    // Ignore comments, identifiers, and regular expressions. Text from catalogs or API data is already an expression.
    if (ts.isJsxText(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const value = node.text.trim();
      const parent = ts.isJsxExpression(node.parent) ? node.parent.parent : node.parent;
      const visible = ts.isJsxText(node) || (ts.isJsxAttribute(parent) && visibleAttributes.has(parent.name.getText(ast)));
      if (!isLocaleAutonym(node) && (/\p{Script=Cyrillic}/u.test(value) ||
        (visible && /\p{L}/u.test(value) && !technicalValues.has(value)))) {
        const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        issues.push(`${ast.fileName}:${line + 1}:${character + 1} ${JSON.stringify(value)}`);
      }
    }
    ts.forEachChild(node, check);
  }
  check(ast);
  return issues;
}

function messageReferences() {
  const literals = new Set<string>();
  const templates: RegExp[] = [];
  for (const ast of syntax) {
    const inCatalog = Object.hasOwn(modules, ast.fileName);
    function visit(node: ts.Node) {
      // A literal or property read can name a message indirectly, for example in a key map or a shared catalog entry.
      if (ts.isPropertyAccessExpression(node)) literals.add(node.name.text);
      if (!inCatalog && ts.isStringLiteralLike(node)) literals.add(node.text);
      if (!inCatalog && ts.isTemplateExpression(node) && ts.isCallExpression(node.parent) && node.parent.arguments[0] === node) {
        // Let enum-based keys such as `column_${sort}` cover their whole family. A bare interpolation is not evidence.
        const segments = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
        if (segments.some(Boolean) && segments.every(value => /^[\w-]*$/.test(value))) {
          templates.push(new RegExp('^' + segments.join('.*') + '$'));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { literals, templates };
}

describe('localization coverage', () => {
  it('validates every bundled locale catalog', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(0);
    for (const path of Object.keys(modules)) expect(catalogs.some(catalog => catalog.path === path), path).toBe(true);
    for (const { path, name, catalog } of catalogs) {
      expect(Object.keys(catalog).length, `${path} · ${name}`).toBeGreaterThan(0);
      expect(validateCatalog(name, catalog), `${path} · ${name}`).toEqual([]);
    }
  });

  it('gets visible renderer copy from the catalogs', () => {
    expect(renderer.length).toBeGreaterThan(0);
    expect(renderer.flatMap(hardcodedCopy)).toEqual([]);
  });

  it('recognizes static Russian diagnostics from the server error classes', () => {
    const errorTypes = new Set(['ApiError', 'RequestError', 'PacError', 'TlsProfileError', 'ProxyRequestError', 'Error']);
    const missing: string[] = [];
    let checked = 0;
    for (const ast of syntax.filter(file => file.fileName.startsWith('../src/server/'))) {
      function visit(node: ts.Node) {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && errorTypes.has(node.expression.text)) {
          for (const argument of node.arguments ?? []) {
            if (!ts.isStringLiteralLike(argument) || !/\p{Script=Cyrillic}/u.test(argument.text)) continue;
            checked++;
            if (!diagnosticReference(argument.text)) missing.push(`${ast.fileName}: ${argument.text}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('finds references to bundled message keys', () => {
    const { literals, templates } = messageReferences();
    const unreferenced = catalogs.flatMap(({ path, name, catalog }) => {
      // The diagnostics lookup indexes all entries and selects keys from incoming structured errors at runtime.
      if (path.endsWith('/locales/diagnostics.ts')) return [];
      return Object.keys(catalog).filter(key => !literals.has(key) && !templates.some(pattern => pattern.test(key)))
        .map(key => `${name}.${key}`);
    });
    expect(unreferenced).toEqual([]);
  });
});
