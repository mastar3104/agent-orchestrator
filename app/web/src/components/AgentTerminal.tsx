import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ItemEvent, OutputEvent } from '@agent-orch/shared';
import * as api from '../api/client';

interface AgentTerminalProps {
  itemId: string;
  agentId: string;
  events?: ItemEvent[];
}

export function AgentTerminal({ itemId, agentId, events }: AgentTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || terminalInstance.current) return;

    const terminal = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#404040',
      },
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });

    fitAddon.current = new FitAddon();
    terminal.loadAddon(fitAddon.current);

    terminal.open(terminalRef.current);
    fitAddon.current.fit();

    // Handle input
    terminal.onData((data) => {
      api.sendAgentInput(itemId, agentId, data).catch(console.error);
    });

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      api.resizeAgentTerminal(itemId, agentId, cols, rows).catch(console.error);
    });

    terminalInstance.current = terminal;
  }, [itemId, agentId]);

  // Initialize terminal
  useEffect(() => {
    if (!initializedRef.current) {
      initTerminal();
      initializedRef.current = true;

      // Load initial output
      api.getAgentOutput(itemId, agentId).then(({ output }) => {
        if (terminalInstance.current && output) {
          terminalInstance.current.write(output);
        }
      }).catch(console.error);
    }

    return () => {
      if (terminalInstance.current) {
        terminalInstance.current.dispose();
        terminalInstance.current = null;
        initializedRef.current = false;
      }
    };
  }, [itemId, agentId, initTerminal]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (fitAddon.current) {
        fitAddon.current.fit();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Handle new events
  useEffect(() => {
    if (!terminalInstance.current || !events) return;

    for (const event of events) {
      if (
        (event.type === 'stdout' || event.type === 'stderr') &&
        event.agentId === agentId
      ) {
        const outputEvent = event as OutputEvent;
        terminalInstance.current.write(outputEvent.data);
      }
    }
  }, [events, agentId]);

  return (
    <div className="terminal-container h-full">
      <div ref={terminalRef} className="h-full" />
    </div>
  );
}
