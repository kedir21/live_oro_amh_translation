
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  color: string;
}

export const Visualizer: React.FC<VisualizerProps> = ({ isActive, color }) => {
  const barsRef = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      barsRef.current.forEach((bar) => {
        if (bar) {
          const height = Math.random() * 100 + 20;
          bar.style.height = `${height}%`;
        }
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isActive]);

  return (
    <div className="flex items-center justify-center gap-1 h-12 w-32">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          ref={(el) => { if (el) barsRef.current[i] = el; }}
          className="w-1 rounded-full transition-all duration-150"
          style={{ 
            backgroundColor: color, 
            height: isActive ? '30%' : '10%',
            opacity: isActive ? 1 : 0.3
          }}
        />
      ))}
    </div>
  );
};
