/**
 * Python StateMachine.update skips take_input once a state's start/begin
 * returned 'repeat', so a key pressed on the frame a state starts (and hands
 * off) is dropped instead of being consumed by it.
 */
import { expect, test } from '@playwright/test';

test('input is not delivered on a frame where start/begin asked to repeat', async ({ page }) => {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
  const result = await page.evaluate(async () => {
    const { StateMachine } = await import('/src/engine/state-machine.ts');
    const { Surface } = await import('/src/engine/surface.ts');
    const inputs: string[] = [];
    const make = (name: string, beginRepeat: boolean) => ({
      name, started: false, processed: false, transparent: false, mapBackdrop: false,
      start() { return undefined; },
      begin() { return beginRepeat ? 'repeat' : undefined; },
      takeInput(event: any) { if (event) inputs.push(`${name}:${event}`); return undefined; },
      update() { return undefined; },
      draw(surf: any) { return surf; },
      end() { return undefined; },
      finish() {},
    });
    const machine = new StateMachine();
    machine.register(make('hands_off', true) as any);
    machine.register(make('steady', false) as any);
    const surf = new Surface(16, 16);
    machine.change('hands_off');
    machine.update(null, surf);          // pushes hands_off
    machine.update('SELECT', surf);      // begin repeats: SELECT dropped
    machine.update('SELECT', surf);      // now it takes input
    machine.change('steady');
    machine.update(null, surf);
    machine.update('BACK', surf);        // begin does not repeat: same frame
    return inputs;
  });
  expect(result).toEqual(['hands_off:SELECT', 'steady:BACK']);
});
