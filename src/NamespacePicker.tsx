import { useState } from 'react';
import { Button, Menu, MenuItem, ListItemIcon, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/CheckOutlined';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDownOutlined';

// EDA-style namespace picker: a labelled button that opens a menu of namespaces, the active
// one marked with a check (mirrors EDA's own NamespacePicker). '' is the All Namespaces entry.
export default function NamespacePicker({ value, options, onChange }: {
  value: string; options: string[]; onChange: (ns: string) => void;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const items = [{ id: '', label: 'All Namespaces' }, ...options.map((n) => ({ id: n, label: n }))];
  const current = items.find((i) => i.id === value)?.label ?? 'All Namespaces';

  return (
    <>
      <Button size="small" variant="outlined" endIcon={<ArrowDropDownIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ color: 'text.primary', borderColor: 'divider', textTransform: 'none', fontWeight: 500, minWidth: 150, justifyContent: 'space-between' }}>
        {current}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { minWidth: 180 } } }}>
        {items.map((it) => (
          <MenuItem key={it.id} selected={it.id === value} dense
            onClick={() => { onChange(it.id); setAnchor(null); }}>
            <ListItemIcon sx={{ minWidth: 28 }}>
              {it.id === value && <CheckIcon fontSize="small" sx={{ color: 'info.main' }} />}
            </ListItemIcon>
            <Typography variant="body2" sx={{ color: it.id === value ? 'info.main' : 'text.primary' }}>{it.label}</Typography>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
