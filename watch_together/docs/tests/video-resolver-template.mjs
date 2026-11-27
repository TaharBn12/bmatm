import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../java-server/src/com/watchtogether/VideoResolver.java', import.meta.url), 'utf8');
const fields = source.match(/private static final String FIELDS = "([^"]+)";/)?.[1];
assert.ok(fields, 'VideoResolver declares its yt-dlp output template');
assert.equal(fields, '%(url)s\\t%(title)s\\t%(thumbnail)s',
  'Java escapes each TSV separator once so yt-dlp emits actual tab characters');

// Model Java's supported \t literal and make sure its output is parseable as three TSV columns.
const javaTemplate = fields.replace(/\\t/g, '\t');
const sample = {
  url: 'https://cdn.example/video.mp4',
  title: 'Sample video',
  thumbnail: 'https://img.example/poster.jpg'
};
const printed = javaTemplate
  .replace('%(url)s', sample.url)
  .replace('%(title)s', sample.title)
  .replace('%(thumbnail)s', sample.thumbnail);
assert.deepEqual(printed.split('\t'), [sample.url, sample.title, sample.thumbnail]);

const lineSeparator = source.match(/text\.split\("([^"]+)"\)/)?.[1];
assert.equal(lineSeparator, '\\\\R', 'parseFields splits output lines with Java regex \\R');
const fieldSeparator = source.match(/last\.split\("([^"]+)", -1\)/)?.[1];
assert.equal(fieldSeparator, '\\\\t', 'parseFields splits columns using a tab regex');

console.log('VideoResolver TSV template and Java splitting escapes passed');
