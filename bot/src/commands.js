/**
 * The slash commands, as Discord's API registers them
 * (PUT /applications/<app>/commands, scripts/register.mjs). Plain JSON, so
 * registering needs no client and the tests read them as they are sent.
 *
 * Option types (Discord's numbers): 3 string, 5 boolean, 6 user, 11 attachment.
 */

const es = (text) => ({ 'es-ES': text, 'es-419': text });

export const COMMANDS = [
  {
    name: 'time-song',
    description: 'Time a song: send its audio and get BPM, offset and red lines from Overtone.',
    description_localizations: es('Timeá una canción: mandá el audio y recibí BPM, offset y red lines de Overtone.'),
    options: [
      {
        type: 11, name: 'audio', required: true,
        description: 'The song: MP3, OGG, WAV, FLAC, M4A or Opus.',
        description_localizations: es('La canción: MP3, OGG, WAV, FLAC, M4A u Opus.'),
      },
      {
        type: 5, name: 'publish', required: false,
        description: 'Publish the timing when it is done, with a public page to share.',
        description_localizations: es('Publicar el timing cuando termine, con una página pública para compartir.'),
      },
      {
        type: 5, name: 'private', required: false,
        description: 'Keep the song and your name off the public queue while it waits.',
        description_localizations: es('No mostrar la canción ni tu nombre en la cola pública mientras espera.'),
      },
    ],
  },
  {
    name: 'timing',
    description: 'Show a published timing, from its link or id.',
    description_localizations: es('Mostrar un timing publicado, por su link o id.'),
    options: [
      {
        type: 3, name: 'timing', required: true, max_length: 200,
        description: 'The timing\'s link (…/t/<id>) or id.',
        description_localizations: es('El link del timing (…/t/<id>) o su id.'),
      },
    ],
  },
  {
    name: 'queue',
    description: 'How many songs wait in Overtone\'s queue, and where yours are.',
    description_localizations: es('Cuántas canciones esperan en la cola de Overtone, y dónde están las tuyas.'),
  },
  {
    name: 'compare',
    description: 'Compare two timings: BPM, offset and red lines side by side.',
    description_localizations: es('Comparar dos timings: BPM, offset y red lines lado a lado.'),
    options: ['a', 'b'].map((name) => ({
      type: 3, name, required: true, max_length: 200,
      description: `Timing ${name.toUpperCase()}: a link or an id.`,
      description_localizations: es(`Timing ${name.toUpperCase()}: un link o un id.`),
    })),
  },
  {
    name: 'recent',
    description: 'The latest published timings of someone with a linked Overtone account.',
    description_localizations: es('Los últimos timings publicados de alguien con una cuenta de Overtone vinculada.'),
    options: [
      {
        type: 6, name: 'user', required: false,
        description: 'Whose timings (you, if empty).',
        description_localizations: es('De quién (vos, si lo dejás vacío).'),
      },
    ],
  },
  {
    name: 'link',
    description: 'Link this Discord account to Overtone, with the code from your profile.',
    description_localizations: es('Vincular esta cuenta de Discord a Overtone, con el código de tu perfil.'),
    options: [
      {
        type: 3, name: 'code', required: true, max_length: 16,
        description: 'The code your Overtone profile shows.',
        description_localizations: es('El código que muestra tu perfil de Overtone.'),
      },
    ],
  },
  {
    name: 'notify',
    description: 'A DM when an analysis of your Overtone account ends: on or off.',
    description_localizations: es('Un DM cuando termina un análisis de tu cuenta de Overtone: activado o no.'),
    options: [
      {
        type: 3, name: 'state', required: true,
        description: 'on or off',
        description_localizations: es('on u off'),
        choices: [
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
        ],
      },
    ],
  },
];

const ID = /^[0-9a-f]{32}$/;

/**
 * A timing reference as people paste it: the 32-character id, or a link to
 * its page (`/t/<id>`) or its result (`/analyze/<id>`) on any host, since
 * staging and production share the shape. `null` when it is neither.
 */
export const parseRef = (raw) => {
  const text = String(raw ?? '').trim().replace(/^<|>$/g, '');
  if (ID.test(text.toLowerCase())) return text.toLowerCase();
  try {
    const url = new URL(text);
    const match = /^\/(?:t|analyze)\/([0-9a-f]{32})\/?$/i.exec(url.pathname);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
};
