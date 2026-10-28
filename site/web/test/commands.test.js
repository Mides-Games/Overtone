import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fold, fuzzyMatch, globalShortcut, isTyping, rankCommands } from '../src/lib/commands.js'

/**
 * The command palette's ranking and the global keys' rules (W12.14), with
 * plain objects for commands, targets and key events: no browser, no React.
 */
const labels = (results) => results.map((r) => r.command.label)

const COMMANDS = [
  { id: 'a', label: 'song.mp3' },
  { id: 'home', label: 'Home', keywords: ['inicio'] },
  { id: 'analyze', label: 'Analyze', keywords: ['analizar'] },
  { id: 'queue', label: 'Queue' },
  { id: 'recent', label: 'Recent', keywords: ['recientes'] },
  { id: 'settings', label: 'Settings', keywords: ['ajustes'] },
  { id: 'status', label: 'Status' },
  { id: 'dark', label: 'Dark theme' },
  { id: 'light', label: 'Light theme' },
  { id: 'system', label: 'Theme as the system' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', keywords: ['?'] },
]

test('folding drops case and accents and keeps one character per letter', () => {
  assert.equal(fold('Análisis ÑANDÚ'), 'analisis nandu')
  assert.equal(fold('Análisis').length, 'Análisis'.length)
  assert.equal(fold(null), '')
})

test('a match needs every typed character, in order', () => {
  assert.ok(fuzzyMatch('rcnt', 'Recent'))
  assert.equal(fuzzyMatch('tnecer', 'Recent'), null)
  assert.equal(fuzzyMatch('x', 'Recent'), null)
  // Spaces separate words; they do not have to be in the label.
  assert.ok(fuzzyMatch('dark them', 'Dark theme'))
  assert.ok(fuzzyMatch('analisis', 'Análisis'))
})

test('word starts and runs score higher than scattered letters', () => {
  assert.deepEqual(fuzzyMatch('ar', 'Analysis Result').positions, [0, 9])
  assert.ok(fuzzyMatch('rec', 'Recent').score > fuzzyMatch('rec', 'Precise').score)
  assert.ok(fuzzyMatch('set', 'Settings').score > fuzzyMatch('set', 'Status entry').score)
})

test('a jump to a word start that strands the rest falls back to the plain walk', () => {
  // Preferring the "a" of the second word leaves no "b" after it.
  const hit = fuzzyMatch('ab', 'xab a')
  assert.ok(hit)
  assert.deepEqual(hit.positions, [1, 2])
})

test('an empty query lists every command in its own order', () => {
  assert.deepEqual(labels(rankCommands('', COMMANDS)), COMMANDS.map((c) => c.label))
  assert.deepEqual(labels(rankCommands('   ', COMMANDS)), COMMANDS.map((c) => c.label))
  assert.equal(rankCommands('', COMMANDS, { limit: 3 }).length, 3)
})

test('the best match comes first and the misses are dropped', () => {
  assert.equal(labels(rankCommands('set', COMMANDS))[0], 'Settings')
  assert.equal(labels(rankCommands('q', COMMANDS))[0], 'Queue')
  assert.deepEqual(labels(rankCommands('theme', COMMANDS)).slice(0, 3).sort(), ['Dark theme', 'Light theme', 'Theme as the system'])
  assert.equal(labels(rankCommands('theme', COMMANDS))[0], 'Theme as the system')
  assert.deepEqual(rankCommands('zzz', COMMANDS), [])
})

test('a keyword finds a command, a little below a label match', () => {
  assert.equal(labels(rankCommands('ajustes', COMMANDS))[0], 'Settings')
  assert.equal(labels(rankCommands('inicio', COMMANDS))[0], 'Home')
  assert.equal(labels(rankCommands('?', COMMANDS))[0], 'Keyboard shortcuts')
  // A keyword match carries no positions: nothing in the label to highlight.
  assert.deepEqual(rankCommands('ajustes', COMMANDS)[0].positions, [])
})

test('equal scores keep the commands\' own order', () => {
  const same = [
    { id: 1, label: 'Song' },
    { id: 2, label: 'Song' },
    { id: 3, label: 'Song' },
  ]
  assert.deepEqual(
    rankCommands('song', same).map((r) => r.command.id),
    [1, 2, 3],
  )
})

test('a match carries the label positions to highlight', () => {
  const [first] = rankCommands('rcnt', COMMANDS)
  assert.equal(first.command.label, 'Recent')
  assert.deepEqual(first.positions, [0, 2, 4, 5])
})

test('typing is a text field, a text area, a select or an editable region, not a slider or a button', () => {
  assert.equal(isTyping({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isTyping({ tagName: 'INPUT', type: 'search' }), true)
  assert.equal(isTyping({ tagName: 'INPUT' }), true)
  assert.equal(isTyping({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTyping({ tagName: 'SELECT' }), true)
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTyping({ tagName: 'INPUT', type: 'range' }), false)
  assert.equal(isTyping({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isTyping({ tagName: 'BUTTON' }), false)
  assert.equal(isTyping({ tagName: 'BODY' }), false)
  assert.equal(isTyping(null), false)
})

test('Ctrl+K and ⌘K open the palette, even from a field', () => {
  const field = { tagName: 'INPUT', type: 'text' }
  assert.equal(globalShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'BODY' } }), 'palette')
  assert.equal(globalShortcut({ key: 'K', metaKey: true, target: field }), 'palette')
  assert.equal(globalShortcut({ key: 'k', ctrlKey: true, shiftKey: true }), null)
  assert.equal(globalShortcut({ key: 'k', ctrlKey: true, altKey: true }), null)
  assert.equal(globalShortcut({ key: 'k', target: { tagName: 'BODY' } }), null)
})

test('? opens the help, but never while typing', () => {
  assert.equal(globalShortcut({ key: '?', shiftKey: true, target: { tagName: 'BODY' } }), 'help')
  assert.equal(globalShortcut({ key: '?', shiftKey: true, target: { tagName: 'INPUT', type: 'text' } }), null)
  assert.equal(globalShortcut({ key: '?', shiftKey: true, target: { tagName: 'TEXTAREA' } }), null)
  assert.equal(globalShortcut({ key: '?', shiftKey: true, target: { tagName: 'INPUT', type: 'range' } }), 'help')
  assert.equal(globalShortcut({ key: '?', ctrlKey: true, target: { tagName: 'BODY' } }), null)
})

test('a held key or an IME composition never fires a shortcut', () => {
  assert.equal(globalShortcut({ key: 'k', ctrlKey: true, repeat: true }), null)
  assert.equal(globalShortcut({ key: '?', isComposing: true, target: { tagName: 'BODY' } }), null)
  assert.equal(globalShortcut(null), null)
})
