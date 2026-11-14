import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import type { PortabilityAnalysis } from '../../../../shared/wireTypes';
import { errorMessage } from '../../../components/errorMessage';
import { downloadBlob } from '../../../persistence/importExport';
import { runtimeClient, RuntimeApiError } from '../../../runtime/runtimeClient';
import { Sheet } from '../../../ui/Sheet';
import { Switch } from '../../../ui/controls';
import { useToast } from '../../../ui/Toast';
import { PortabilityPanel } from './PortabilityPanel';
import './exportSheet.css';

type ExportFormat = 'yaml' | 'bundle';

const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'yaml', label: 'YAML', hint: 'The spec only. Opens in any editor.' },
  {
    value: 'bundle',
    label: 'Bundle',
    hint: 'The spec, labels, its registry prompt and eval examples, as one JSON file.',
  },
];

/**
 * L09b's export sheet: pick YAML or bundle, optionally run the
 * portability check and download with the `[YOUR …]`-adapted
 * instructions substituted. A 409 `LOUSHO_PORTABILITY_MISSING` means the
 * spec changed since the check ran - the panel remounts idle, the adapt
 * switch resets and the stale message shows until the next check.
 */
export function ExportSheet({
  agentId,
  agentName,
  open,
  onClose,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose(): void;
}): JSX.Element {
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>('yaml');
  const [analysis, setAnalysis] = useState<PortabilityAnalysis | undefined>(undefined);
  const [adapt, setAdapt] = useState(false);
  const [panelKey, setPanelKey] = useState(0);
  const [stale, setStale] = useState(false);
  const [exporting, setExporting] = useState(false);

  const hasAdaptation = analysis?.adaptedInstructions != null;

  async function download(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setStale(false);
    try {
      const { blob, filename, warnings } = await runtimeClient.downloadExport(agentId, format, {
        adapt: adapt && hasAdaptation,
      });
      downloadBlob(blob, filename);
      for (const warning of warnings) toast.show({ message: warning, tone: 'warning' });
      if (warnings.length === 0) toast.show({ message: `Exported ${filename}`, tone: 'success' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 409 && error.code === 'LOUSHO_PORTABILITY_MISSING') {
        setAnalysis(undefined);
        setAdapt(false);
        setStale(true);
        setPanelKey((key) => key + 1);
      } else {
        toast.show({ message: `Export failed: ${errorMessage(error)}`, tone: 'error' });
      }
    } finally {
      setExporting(false);
    }
  }

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Cancel
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void download()} disabled={exporting}>
        {exporting ? <LoaderCircle size={14} className="btn-spinner" aria-hidden="true" /> : null}
        Download
      </button>
    </>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Export ${agentName}`}
      description="Download this agent to keep it, share it or import it into another workspace."
      size="lg"
      footer={footer}
    >
      <div className="export-sheet">
        <fieldset className="export-format">
          <legend>Format</legend>
          {FORMATS.map((option) => (
            <label key={option.value} className="export-format-option">
              <input
                type="radio"
                name="export-format"
                value={option.value}
                checked={format === option.value}
                onChange={() => setFormat(option.value)}
              />
              <span className="export-format-text">
                {option.label} <span className="hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <PortabilityPanel
          key={panelKey}
          run={() => runtimeClient.checkPortability(agentId)}
          onAnalysis={setAnalysis}
        />
        {hasAdaptation ? (
          <div className="export-adapt">
            <label className="toggle-row">
              <span>Use adapted instructions in the export</span>
              <Switch size="sm" checked={adapt} onChange={setAdapt} label="Use adapted instructions in the export" />
            </label>
          </div>
        ) : null}
        {stale ? (
          <p className="export-error" role="alert">
            The agent changed since the check. Run it again.
          </p>
        ) : null}
        <p className="export-secrets">Secret values are never exported, only their names.</p>
      </div>
    </Sheet>
  );
}
