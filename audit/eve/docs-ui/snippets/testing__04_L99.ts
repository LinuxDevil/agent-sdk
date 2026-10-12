// testing.md:99
expect(model.calls[0].messages[0]).toMatchObject({ role: 'system' });
expect(model.lastCall?.tools?.map((t) => t.function.name)).toContain('get_weather');
// `createAgent()` has no `temperature` option; it reaches the request through a
// `preGenerate` hook (`ctx.request.temperature`) or `ExecuteOptions.temperature`.
expect(model.calls[0].temperature).toBe(0.2);
export {};
