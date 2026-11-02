import ts from 'typescript';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Test references never satisfy production exports; re-exports propagate real consumer demand. */
export function findUnusedValueExports(configPath = 'tsconfig.json') {
  const absoluteConfig = path.resolve(configPath);
  const root = path.dirname(absoluteConfig);
  const config = ts.readConfigFile(absoluteConfig, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const inSource = file => file.startsWith(path.join(root, 'src') + path.sep);
  const program = ts.createProgram(parsed.fileNames.filter(file => !file.startsWith(path.join(root, 'tests') + path.sep)), parsed.options);
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter(source => inSource(source.fileName) && !source.isDeclarationFile);
  const key = (file, name) => `${file}\0${name}`;
  const exports = new Map(), edges = new Map(), needed = new Set();
  function target(module, name) {
    const symbol = checker.getSymbolAtLocation(module);
    const source = symbol?.declarations?.find(ts.isSourceFile);
    return source && inSource(source.fileName) ? key(source.fileName, name) : undefined;
  }
  function link(from, to) {
    if (to) edges.set(from, [...edges.get(from) ?? [], to]);
  }
  for (const source of sources) {
    const module = checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      if (exported.declarations?.some(declaration => ts.isExportSpecifier(declaration) &&
        (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly))) continue;
      const value = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (value.flags & ts.SymbolFlags.Value) exports.set(key(source.fileName, exported.name), { file: source.fileName, name: exported.name });
    }
    const imports = new Map(), namespaces = new Map(), localExports = new Map();
    for (const exported of checker.getExportsOfModule(module)) {
      if (exported.declarations?.some(declaration => ts.isExportSpecifier(declaration) &&
        (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly))) continue;
      const value = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (value.declarations?.some(declaration => declaration.getSourceFile() === source)) {
        localExports.set(value, [...localExports.get(value) ?? [], key(source.fileName, exported.name)]);
      }
    }
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !node.importClause) continue;
      const clause = node.importClause;
      if (clause.name) imports.set(checker.getSymbolAtLocation(clause.name), target(node.moduleSpecifier, 'default'));
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        imports.set(checker.getSymbolAtLocation(binding.name), target(node.moduleSpecifier, (binding.propertyName ?? binding.name).text));
      }
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(checker.getSymbolAtLocation(bindings.name), node.moduleSpecifier);
    }
    for (const node of source.statements) {
      if (!ts.isExportDeclaration(node)) continue;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const binding of node.exportClause.elements) {
          const from = key(source.fileName, binding.name.text);
          if (node.moduleSpecifier) link(from, target(node.moduleSpecifier, (binding.propertyName ?? binding.name).text));
          else link(from, imports.get(checker.getExportSpecifierLocalTargetSymbol(binding)));
        }
      } else if (node.moduleSpecifier) {
        const module = checker.getSymbolAtLocation(node.moduleSpecifier);
        const names = module ? checker.getExportsOfModule(module).filter(symbol => symbol.name !== 'default') : [];
        if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          for (const name of names) link(key(source.fileName, node.exportClause.name.text), target(node.moduleSpecifier, name.name));
        } else for (const name of names) link(key(source.fileName, name.name), target(node.moduleSpecifier, name.name));
      }
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        // Declaration names do not count as uses. Internal runtime calls still count:
        // exported UI components can be rendered in this same production module.
        const declarationName = node.parent.name === node && (ts.isDeclarationStatement(node.parent) ||
          ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent));
        if (!declarationName) for (const exported of localExports.get(symbol) ?? []) needed.add(exported);
        const imported = imports.get(symbol);
        if (imported) needed.add(imported);
        const namespace = namespaces.get(symbol);
        if (namespace) {
          if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
            const selected = target(namespace, node.parent.name.text);
            if (selected) needed.add(selected);
          } else {
            // Passing/using a namespace as a whole can access any of its exports.
            const module = checker.getSymbolAtLocation(namespace);
            for (const name of module ? checker.getExportsOfModule(module) : []) {
              const selected = target(namespace, name.name);
              if (selected) needed.add(selected);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const queue = [...needed];
  for (let i = 0; i < queue.length; i++) for (const dependency of edges.get(queue[i]) ?? []) {
    if (!needed.has(dependency)) { needed.add(dependency); queue.push(dependency); }
  }
  return [...exports].filter(([id]) => !needed.has(id)).map(([, { file, name }]) => `${path.relative(root, file)}: ${name}`).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const unused = findUnusedValueExports(process.argv[2]);
  if (unused.length) { console.error(unused.join('\n')); process.exitCode = 1; }
  else console.log('No unused value exports (production references only).');
}
