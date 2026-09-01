import { Fragment, type ReactNode } from 'react';

interface PaneSurfaceHostProps {
  ownerKey: string;
  primary: ReactNode;
  controls: ReactNode;
}

// A pane owns one complete Surface bundle. The keyed fragments deliberately give the primary Surface
// and its controls separate sibling identities, even when their child components carry the same
// conversation key. Changing the host key replaces the whole bundle in one React ownership boundary.
export default function PaneSurfaceHost({ ownerKey, primary, controls }: PaneSurfaceHostProps) {
  return (
    <>
      <Fragment key={`primary\0${ownerKey}`}>{primary}</Fragment>
      <Fragment key={`controls\0${ownerKey}`}>{controls}</Fragment>
    </>
  );
}
