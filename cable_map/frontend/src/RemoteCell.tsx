import InputBase from '@mui/material/InputBase';
import { edgeRemote, useEdgeRemote } from './edge-remote';

// Edge-link freetext (remote node / remote port) — editable in the drawer, plain text in print.
export default function RemoteCell({ nodeId, port, field, placeholder, editable }:
  { nodeId: string; port: string; field: 'node' | 'port'; placeholder: string; editable: boolean }) {
  const value = useEdgeRemote(nodeId, port, field);
  if (!editable) return value ? <>{value}</> : null;
  return (
    <InputBase value={value} onChange={(e) => edgeRemote.set(nodeId, port, field, e.target.value)}
      placeholder={placeholder} fullWidth
      sx={{ font: 'inherit', '& input': { p: 0, height: 'auto' }, '& input::placeholder': { opacity: 0.6 } }} />
  );
}
