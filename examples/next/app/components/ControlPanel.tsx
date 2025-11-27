'use client';

import { PointSizeSlider } from './PointSizeSlider';
import { ColorExpressionInput } from './ColorExpressionInput';
import { SearchBox } from './SearchBox';
import { ShowLabelsButton } from './ShowLabelsButton';
import { HoverInfoDisplay } from './HoverInfoDisplay';
import { PointLimitSlider } from './PointLimitSlider';

export function ControlPanel() {
  return (
    <div className="w-80 bg-zinc-100 border-r border-zinc-300 p-4 flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-lg font-semibold text-zinc-800">Controls</h2>
      <PointLimitSlider />
      <PointSizeSlider />
      <ColorExpressionInput />
      <SearchBox />
      <ShowLabelsButton />
      <HoverInfoDisplay />
    </div>
  );
}
