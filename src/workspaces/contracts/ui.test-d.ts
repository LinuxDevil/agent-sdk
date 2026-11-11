import { describe, it, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { pageUiObjectSchema, pageUiSchema, uiComponentOptions, UI_COMPONENTS, type PageUi, type UiComponent, type UiComponentType } from './ui';

type ParsedComponent = z.infer<(typeof uiComponentOptions)[number]>;

describe('pageUiSchema types', () => {
  it('infers exactly PageUi, in and out', () => {
    expectTypeOf<z.infer<typeof pageUiObjectSchema>>().toEqualTypeOf<PageUi>();
    expectTypeOf<PageUi>().toEqualTypeOf<z.infer<typeof pageUiObjectSchema>>();
    expectTypeOf<z.infer<typeof pageUiSchema>>().toEqualTypeOf<PageUi>();
  });

  it('the component options infer exactly UiComponent', () => {
    expectTypeOf<ParsedComponent>().toEqualTypeOf<UiComponent>();
    expectTypeOf<UiComponent>().toEqualTypeOf<ParsedComponent>();
  });

  it('the component types are exactly the catalog', () => {
    expectTypeOf<UiComponent['type']>().toEqualTypeOf<UiComponentType>();
    expectTypeOf<UiComponentType>().toEqualTypeOf<UiComponent['type']>();
    expectTypeOf<(typeof UI_COMPONENTS)['outputs'][number]>().toEqualTypeOf<'text' | 'markdown' | 'json' | 'table' | 'artifact' | 'artifactGallery'>();
  });
});
