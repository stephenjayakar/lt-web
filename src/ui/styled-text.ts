import { Surface } from '../engine/surface';
import { FONT, areFontsReady } from '../rendering/bmp-font';
import { drawIconByAlias } from './icons';

export type StyledTextToken =
  | { kind: 'text'; text: string; color: string }
  | { kind: 'icon'; alias: string };

const COLOR_TAGS: Record<string, string> = {
  black: 'black',
  blue: 'blue',
  brown: 'brown',
  green: 'green',
  grey: 'grey',
  gray: 'grey',
  orange: 'orange',
  purple: 'purple',
  red: 'red',
  violet: 'violet',
  white: 'white',
  yellow: 'yellow',
};

function textWidth(text: string, font: string): number {
  if (areFontsReady()) {
    const bmpFont = FONT[font] ?? FONT.text;
    if (bmpFont) return bmpFont.width(text);
  }
  return text.length * 5;
}

/** Parse LT's stack-based styled text tags, including 16px inline icon aliases. */
export function parseStyledText(text: string, defaultColor = 'white'): StyledTextToken[] {
  const tokens: StyledTextToken[] = [];
  const colorStack = [defaultColor];
  let index = 0;

  const appendText = (value: string): void => {
    if (!value) return;
    const color = colorStack[colorStack.length - 1];
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === 'text' && previous.color === color) previous.text += value;
    else tokens.push({ kind: 'text', text: value, color });
  };

  while (index < text.length) {
    if (text.startsWith('<icon>', index)) {
      const end = text.indexOf('</>', index + 6);
      if (end < 0) break; // A typewriter may not have revealed the closing tag yet.
      const alias = text.slice(index + 6, end).trim();
      if (alias) tokens.push({ kind: 'icon', alias });
      index = end + 3;
      continue;
    }
    if (text.startsWith('</>', index)) {
      if (colorStack.length > 1) colorStack.pop();
      index += 3;
      continue;
    }
    if (text[index] === '<') {
      const end = text.indexOf('>', index + 1);
      if (end < 0) break;
      const tag = text.slice(index + 1, end).trim().toLowerCase();
      colorStack.push(COLOR_TAGS[tag] ?? colorStack[colorStack.length - 1]);
      index = end + 1;
      continue;
    }
    const nextTag = text.indexOf('<', index);
    const end = nextTag < 0 ? text.length : nextTag;
    appendText(text.slice(index, end));
    index = end;
  }

  return tokens;
}

export function measureStyledText(text: string, font = 'text'): number {
  return parseStyledText(text).reduce(
    (width, token) => width + (token.kind === 'icon' ? 16 : textWidth(token.text, font)),
    0,
  );
}

export function styledTextHeight(text: string, lineHeight = 10): number {
  return parseStyledText(text).some((token) => token.kind === 'icon')
    ? Math.max(16, lineHeight)
    : lineHeight;
}

/** Draw styled text in one line. Returns the rendered width. */
export function drawStyledText(
  surf: Surface,
  text: string,
  x: number,
  y: number,
  defaultColor = 'white',
  font = 'text',
): number {
  let cursorX = x;
  for (const token of parseStyledText(text, defaultColor)) {
    if (token.kind === 'icon') {
      drawIconByAlias(surf, token.alias, cursorX, y - 4);
      cursorX += 16;
    } else {
      surf.drawText(token.text, cursorX, y, token.color, font);
      cursorX += textWidth(token.text, font);
    }
  }
  return cursorX - x;
}
