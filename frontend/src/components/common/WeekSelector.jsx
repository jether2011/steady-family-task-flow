import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatWeekRange, shiftWeek, getWeekStart } from '@/lib/familyUtils';

export default function WeekSelector({ weekStart, onChange }) {
  const isCurrent = weekStart === getWeekStart();
  return (
    <div className="inline-flex items-center gap-1.5">
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(shiftWeek(weekStart, -1))}>
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <div className="text-center min-w-[150px] px-1">
        <p className="font-semibold text-sm">{formatWeekRange(weekStart)}</p>
      </div>
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(shiftWeek(weekStart, 1))}>
        <ChevronRight className="w-4 h-4" />
      </Button>
      {!isCurrent && (
        <Button variant="ghost" size="sm" className="ml-1 h-8" onClick={() => onChange(getWeekStart())}>
          This week
        </Button>
      )}
    </div>
  );
}