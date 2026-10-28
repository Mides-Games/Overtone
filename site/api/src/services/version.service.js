import { randomBytes } from 'node:crypto';

import { hasDatabase, pool, query } from '../config/database.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Versions of a timing (W12.21). A version is one of two things:
 *
 * - **A reading**: another analysis of the same audio by the same owner (a
 *   re-analysis, under another engine, say). Nothing is stored for it: the
 *   analyses already are the versions (analysis.service.js `siblings`).
 * - **A saved adjustment**: the owner pressed "save as version" on a ×2 / ÷2
 *   and a nudge. Only the adjustment is stored (`factor`, `nudge_ms`, an
 *   optional label), never a copy of the result: the page applies it to the
 *   analysis it belongs to, exactly as it applies one being tried.
 *
 * Saving the same adjustment twice answers with the one already saved. At
 * most MAX_PER_ANALYSIS a reading. The rows go with their analysis (ON DELETE
 * CASCADE, and `removeAll` when its owner deletes it today).
 */

export const MAX_PER_ANALYSIS = 20;
export const FACTORS = [0.5, 1, 2];
export const NUDGE_LIMIT = 500;
export const LABEL_MAX = 60;

const tooMany = () =>
  new HttpError(409, `A timing keeps at most ${MAX_PER_ANALYSIS} saved versions. Delete one first.`, 'VERSION_LIMIT', { limit: MAX_PER_ANALYSIS });

/** `{ factor, nudgeMs }` from a request body, or null when it is not one the page can apply or changes nothing. */
export const parseAdjustment = (body) => {
  const factor = Number(body?.factor);
  const nudgeMs = body?.nudgeMs;
  if (!FACTORS.includes(factor)) return null;
  if (!Number.isInteger(nudgeMs) || Math.abs(nudgeMs) > NUDGE_LIMIT) return null;
  if (factor === 1 && nudgeMs === 0) return null;
  return { factor, nudgeMs };
};

export const versionView = (v) => ({
  id: v.publicId,
  analysisId: v.analysisId,
  factor: v.factor,
  nudgeMs: v.nudgeMs,
  label: v.label ?? null,
  createdAt: new Date(v.createdAt).toISOString(),
});

// ── Memory ──────────────────────────────────────────────────────────────────

const memory = { versions: new Map() }; // analysis public id -> [version]

const memoryStore = {
  async list(analysisIds) {
    return analysisIds.flatMap((id) => (memory.versions.get(id) ?? []).map((v) => ({ ...v }))).sort((a, b) => b.createdAt - a.createdAt);
  },

  async save(analysisId, { factor, nudgeMs, label }) {
    const list = memory.versions.get(analysisId) ?? [];
    const same = list.find((v) => v.factor === factor && v.nudgeMs === nudgeMs);
    if (same) return { version: { ...same }, created: false };
    if (list.length >= MAX_PER_ANALYSIS) throw tooMany();
    const version = { publicId: randomBytes(16).toString('hex'), analysisId, factor, nudgeMs, label: label ?? null, createdAt: new Date() };
    memory.versions.set(analysisId, [...list, version]);
    return { version: { ...version }, created: true };
  },

  async remove(analysisId, publicId) {
    const list = memory.versions.get(analysisId) ?? [];
    const left = list.filter((v) => v.publicId !== publicId);
    if (left.length === list.length) return false;
    memory.versions.set(analysisId, left);
    return true;
  },

  async removeAll(analysisId) {
    memory.versions.delete(analysisId);
  },
};

// ── PostgreSQL ──────────────────────────────────────────────────────────────

const COLS = 'v.public_id, a.public_id AS analysis_public_id, v.factor, v.nudge_ms, v.label, v.created_at';
const fromRow = (r) => ({
  publicId: r.public_id.trim(),
  analysisId: r.analysis_public_id.trim(),
  factor: Number(r.factor),
  nudgeMs: r.nudge_ms,
  label: r.label,
  createdAt: r.created_at,
});

const pgStore = {
  async list(analysisIds) {
    if (!analysisIds.length) return [];
    const { rows } = await query(
      `SELECT ${COLS} FROM analysis_versions v JOIN analyses a ON a.id = v.analysis_id
        WHERE a.public_id = ANY($1::text[]) ORDER BY v.created_at DESC, v.id DESC`,
      [analysisIds],
    );
    return rows.map(fromRow);
  },

  async save(analysisId, { factor, nudgeMs, label }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The analysis's row lock: two saves at once are counted one after the other.
      const { rows: [analysis] } = await client.query('SELECT id FROM analyses WHERE public_id = $1 FOR UPDATE', [analysisId]);
      if (!analysis) throw new HttpError(404, 'No such analysis.', 'NOT_FOUND');
      const { rows: [same] } = await client.query(
        `SELECT ${COLS} FROM analysis_versions v JOIN analyses a ON a.id = v.analysis_id
          WHERE v.analysis_id = $1 AND v.factor = $2 AND v.nudge_ms = $3`,
        [analysis.id, factor, nudgeMs],
      );
      if (same) {
        await client.query('COMMIT');
        return { version: fromRow(same), created: false };
      }
      const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM analysis_versions WHERE analysis_id = $1', [analysis.id]);
      if (n >= MAX_PER_ANALYSIS) throw tooMany();
      const { rows: [row] } = await client.query(
        `INSERT INTO analysis_versions (public_id, analysis_id, factor, nudge_ms, label)
              VALUES ($1, $2, $3, $4, $5)
           RETURNING public_id, $6::text AS analysis_public_id, factor, nudge_ms, label, created_at`,
        [randomBytes(16).toString('hex'), analysis.id, factor, nudgeMs, label ?? null, analysisId],
      );
      await client.query('COMMIT');
      return { version: fromRow(row), created: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  async remove(analysisId, publicId) {
    const { rowCount } = await query(
      `DELETE FROM analysis_versions v USING analyses a
        WHERE v.analysis_id = a.id AND a.public_id = $1 AND v.public_id = $2`,
      [analysisId, publicId],
    );
    return rowCount > 0;
  },

  async removeAll(analysisId) {
    await query('DELETE FROM analysis_versions v USING analyses a WHERE v.analysis_id = a.id AND a.public_id = $1', [analysisId]);
  },
};

export const versions = () => (hasDatabase() ? pgStore : memoryStore);
