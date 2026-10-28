import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The API's reference for `/developers` (W12.20), read from
 * `site/api/docs/openapi.yaml` at build time, as the changelog reads the
 * timeline: `vite.config.js` serves it as `virtual:openapi`, so the page is
 * always the document as it is, and nothing generated is committed.
 *
 * Why a parser of our own and not Swagger UI or a YAML package: Swagger UI is
 * about a megabyte of script for one page, and the document is written by
 * hand in a small corner of YAML (block mappings and sequences, flow `{ }`
 * and `[ ]`, quoted and plain scalars, `|` and `>` blocks, comments). This
 * reads that corner and throws, with the line, on anything outside it, so a
 * construct it does not know can never be misread into the page: the build
 * stops instead. It runs at build time only and ships nothing.
 *
 * `reduce()` keeps what the page shows: the info text, each operation's
 * method, path, summary, description, token scope, parameters, request body
 * and responses, and the schemas, with `$ref`s left as names to link.
 */

export const openapiPath = fileURLToPath(new URL('../../api/docs/openapi.yaml', import.meta.url))

// ── YAML, the subset the document uses ──────────────────────────────────────

class YamlError extends Error {
  constructor(message, line) {
    super(`openapi.yaml line ${line + 1}: ${message}`)
  }
}

const indentOf = (line) => line.length - line.trimStart().length
const blank = (line) => /^\s*(#.*)?$/.test(line)

/** A plain scalar as YAML 1.2's core schema reads it. */
function plain(text) {
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?(0|[1-9]\d*)$/.test(text)) return Number(text)
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(text)) return Number(text)
  return text
}

/** A quoted scalar starting at `s[i]`; returns `[value, next index]`. */
function quoted(s, i, line) {
  const q = s[i]
  let out = ''
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]
    if (q === "'") {
      if (c === "'") {
        if (s[j + 1] === "'") {
          out += "'"
          j++
          continue
        }
        return [out, j + 1]
      }
      out += c
      continue
    }
    if (c === '"') return [out, j + 1]
    if (c === '\\') {
      const e = s[++j]
      const map = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', 0: '\0' }
      if (e in map) out += map[e]
      else if (e === 'u') {
        out += String.fromCharCode(parseInt(s.slice(j + 1, j + 5), 16))
        j += 4
      } else throw new YamlError(`unknown escape \\${e}`, line)
      continue
    }
    out += c
  }
  throw new YamlError('a quoted string is not closed on its line', line)
}

/** A flow value (`{…}`, `[…]`, quoted or plain) in `s` from `i`; returns `[value, next index]`. */
function flow(s, i, line) {
  const skip = () => {
    while (s[i] === ' ') i++
  }
  skip()
  const c = s[i]
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']'
    const out = c === '{' ? {} : []
    i++
    for (;;) {
      skip()
      if (s[i] === close) return [out, i + 1]
      if (c === '{') {
        let key
        if (s[i] === "'" || s[i] === '"') [key, i] = quoted(s, i, line)
        else {
          const m = /^[^:,{}[\]]+/.exec(s.slice(i))
          if (!m) throw new YamlError('a flow mapping key is missing', line)
          key = m[0].trim()
          i += m[0].length
        }
        skip()
        if (s[i] !== ':') throw new YamlError(`"${key}" has no value in a flow mapping`, line)
        i++
        let value
        ;[value, i] = flow(s, i, line)
        out[key] = value
      } else {
        let value
        ;[value, i] = flow(s, i, line)
        out.push(value)
      }
      skip()
      if (s[i] === ',') i++
      else if (s[i] !== close) throw new YamlError(`expected , or ${close} in a flow collection`, line)
    }
  }
  if (c === "'" || c === '"') return quoted(s, i, line)
  // A plain scalar inside a flow collection ends at , ] or }.
  const m = /^[^,{}[\]]*/.exec(s.slice(i))
  return [plain(m[0].trim()), i + m[0].length]
}

/** A whole inline value: flow or scalar, with nothing after it but a comment. */
function inlineValue(text, line) {
  const t = text.trim()
  if (t[0] === '{' || t[0] === '[' || t[0] === "'" || t[0] === '"') {
    const [value, end] = flow(t, 0, line)
    if (!/^\s*(#.*)?$/.test(t.slice(end))) throw new YamlError(`unexpected text after a value: ${t.slice(end)}`, line)
    return value
  }
  if (/\s#/.test(t)) throw new YamlError('a comment after a plain value is not read; quote the value', line)
  if (/^[&*!%@`|>]/.test(t)) throw new YamlError(`"${t[0]}" is not read here`, line)
  return plain(t)
}

/** The key of a `key: value` line and the rest, or null when the line is not one. */
function keyOf(content, line) {
  if (content[0] === "'" || content[0] === '"') {
    const [key, end] = quoted(content, 0, line)
    const rest = content.slice(end)
    if (!/^:(\s|$)/.test(rest)) throw new YamlError('a quoted key must be followed by ":"', line)
    return [key, rest.slice(1)]
  }
  const m = /^([^\s#'"{}[\],][^:#]*?):(\s|$)/.exec(content)
  return m ? [m[1], content.slice(m[0].length - (m[2] ? 1 : 0))] : null
}

export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const tabbed = lines.findIndex((l) => /^ *\t/.test(l))
  if (tabbed >= 0) throw new YamlError('a tab in the indentation', tabbed)
  let i = 0
  const next = () => {
    while (i < lines.length && blank(lines[i])) i++
    return i < lines.length ? i : -1
  }

  function block(indent) {
    const at = next()
    if (at < 0) return null
    const content = lines[at].trimStart()
    return content === '-' || content.startsWith('- ') ? sequence(indentOf(lines[at])) : mapping(indentOf(lines[at]))
  }

  /** The value after `key:` on line `at` (indent `indent`), with `rest` the text after the colon. */
  function valueAfter(rest, indent, at) {
    const t = rest.trim()
    if (/^[|>][-+]?(\s+#.*)?$/.test(t)) return scalarBlock(t, indent)
    if (t && !t.startsWith('#')) {
      // A flow collection may run over several lines: read until it closes.
      if ((t[0] === '{' || t[0] === '[') && !balanced(t)) {
        let joined = t
        while (!balanced(joined)) {
          if (i >= lines.length) throw new YamlError('a flow collection is never closed', at)
          joined += ` ${lines[i++].trim()}`
        }
        return inlineValue(joined, at)
      }
      let value = inlineValue(t, at)
      if (typeof value === 'string' && t[0] !== "'" && t[0] !== '"') {
        // A plain scalar may continue on deeper lines, folded with spaces.
        for (let k = next(); k >= 0 && indentOf(lines[k]) > indent; k = next()) {
          value += ` ${lines[k].trim()}`
          i = k + 1
        }
      }
      return value
    }
    const k = next()
    if (k < 0) return null
    const deeper = indentOf(lines[k]) > indent
    const seqHere = indentOf(lines[k]) === indent && /^-(\s|$)/.test(lines[k].trimStart())
    return deeper || seqHere ? block(indent) : null
  }

  function balanced(t) {
    let depth = 0
    let q = null
    let before = '{' // the last character that was not a space: a quote opens a scalar only where one may start
    for (let k = 0; k < t.length; k++) {
      const c = t[k]
      if (q) {
        if (c === q && !(q === "'" && t[k + 1] === "'")) q = null
        else if (c === q || (q === '"' && c === '\\')) k++
        continue
      }
      if ((c === "'" || c === '"') && '{[,:'.includes(before)) q = c
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') depth--
      if (c !== ' ') before = c
    }
    return depth === 0
  }

  function scalarBlock(header, indent) {
    const folded = header[0] === '>'
    const chomp = header[1] === '-' ? 'strip' : header[1] === '+' ? 'keep' : 'clip'
    const body = []
    let width = null
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === '') {
        body.push('')
        i++
        continue
      }
      const n = indentOf(l)
      if (n <= indent) break
      width ??= n
      if (n < width) throw new YamlError('a block scalar line is less indented than its first', i)
      body.push(l.slice(width))
      i++
    }
    // Trailing blank lines are the chomping's to keep or drop, not text.
    let trailing = 0
    while (body.length && body.at(-1) === '') {
      body.pop()
      trailing++
    }
    let out = ''
    if (folded) {
      // Lines join with a space; an empty line is a line break; a more
      // indented line keeps its own line.
      let prev = null
      for (const l of body) {
        if (l === '') out += '\n'
        else if (prev === null || prev === '') out += l
        else if (/^\s/.test(l) || /^\s/.test(prev)) out += `\n${l}`
        else out += ` ${l}`
        prev = l
      }
    } else out = body.join('\n')
    if (chomp === 'strip') return out
    return chomp === 'keep' ? `${out}\n${'\n'.repeat(trailing)}` : `${out}\n`
  }

  function mapping(indent) {
    const out = {}
    for (let at = next(); at >= 0 && indentOf(lines[at]) === indent; at = next()) {
      const content = lines[at].slice(indent)
      if (/^-(\s|$)/.test(content)) break
      const kv = keyOf(content, at)
      if (!kv) throw new YamlError(`expected "key: value", got: ${content}`, at)
      const [key, rest] = kv
      if (Object.hasOwn(out, key)) throw new YamlError(`"${key}" is given twice`, at)
      i = at + 1
      out[key] = valueAfter(rest, indent, at)
    }
    const at = next()
    if (at >= 0 && indentOf(lines[at]) > indent) throw new YamlError('unexpected indentation', at)
    return out
  }

  function sequence(indent) {
    const out = []
    for (let at = next(); at >= 0 && indentOf(lines[at]) === indent && /^-(\s|$)/.test(lines[at].trimStart()); at = next()) {
      const content = lines[at].slice(indent + 1)
      const item = content.trimStart()
      const itemIndent = indent + 1 + (content.length - item.length)
      if (!item) {
        i = at + 1
        out.push(valueAfter('', indent, at))
      } else if (item[0] !== '{' && item[0] !== '[' && keyOf(item, at)) {
        // "- key: value": a mapping whose first line starts after the dash.
        lines[at] = ' '.repeat(itemIndent) + item
        i = at
        out.push(mapping(itemIndent))
      } else {
        i = at + 1
        out.push(valueAfter(item, indent, at))
      }
    }
    return out
  }

  const doc = block(-1)
  const left = next()
  if (left >= 0) throw new YamlError('text after the document ends', left)
  return doc
}

// ── What the page shows ─────────────────────────────────────────────────────

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** `#/components/schemas/Name` -> `Name`. */
const refName = (ref) => String(ref).split('/').at(-1)

/** A schema in a line: its type, enum, pattern, ref; enough to read, not a validator. */
export function schemaLine(schema) {
  if (!schema || typeof schema !== 'object') return ''
  if (schema.$ref) return refName(schema.$ref)
  if (schema.allOf) return schema.allOf.map(schemaLine).join(' & ')
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  const types = [].concat(schema.type ?? [])
  let text = types.length ? types.map((t) => (t === 'array' ? `${schemaLine(schema.items) || 'any'}[]` : t)).join(' | ') : 'object'
  if (schema.enum) text += ` (${schema.enum.map((v) => JSON.stringify(v)).join(', ')})`
  if (schema.pattern) text += ` /${schema.pattern}/`
  if (schema.format) text += ` ${schema.format}`
  return text
}

/** An object schema's properties as rows, or null. */
function fields(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return null
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, s]) => ({
    name, required: required.has(name), type: schemaLine(s), description: s?.description ?? null,
  }))
}

export function reduce(doc) {
  const params = doc.components?.parameters ?? {}
  const param = (p) => {
    const q = p.$ref ? params[refName(p.$ref)] : p
    if (!q) throw new Error(`openapi: unknown parameter ${p.$ref}`)
    return { name: q.name, in: q.in, required: Boolean(q.required), type: schemaLine(q.schema), description: q.description ?? null }
  }
  const operations = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = (item.parameters ?? []).map(param)
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const body = op.requestBody?.content ?? null
      const [bodyType, bodyContent] = body ? Object.entries(body)[0] : [null, null]
      operations.push({
        id: `${method}-${path}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        description: op.description ?? null,
        tokenScope: op['x-token-scope'] ?? null,
        session: (op.security ?? []).some((s) => 'session' in s),
        params: [...shared, ...(op.parameters ?? []).map(param)],
        body: body
          ? { type: bodyType, schema: schemaLine(bodyContent.schema), fields: fields(bodyContent.schema) }
          : null,
        responses: Object.entries(op.responses ?? {}).map(([status, r]) => {
          const content = r.content ? Object.entries(r.content)[0] : null
          return {
            status,
            description: r.$ref ? null : (r.description ?? null),
            schema: content ? schemaLine(content[1].schema) : r.$ref ? refName(r.$ref) : null,
          }
        }),
      })
    }
  }
  const schemas = Object.entries(doc.components?.schemas ?? {}).map(([name, s]) => ({
    name,
    description: s.description ?? null,
    type: schemaLine(s),
    fields: fields(s) ?? (s.allOf ? s.allOf.flatMap((part) => fields(part) ?? []) : null),
  }))
  return {
    title: doc.info?.title ?? 'API',
    version: doc.info?.version ?? '',
    description: doc.info?.description ?? '',
    server: doc.servers?.[0]?.url ?? '',
    operations,
    schemas,
  }
}

export const readOpenApi = () => reduce(parseYaml(readFileSync(openapiPath, 'utf8')))

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(readOpenApi(), null, 2))
}
