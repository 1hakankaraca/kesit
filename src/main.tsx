import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/sofia-sans-extra-condensed/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/screens.css';

import { MotionConfig } from 'motion/react';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Spinner, Toasts } from './components/basics.tsx';
import { loadSession, useSession } from './lib/session.ts';
import { Gate, PairGate } from './screens/Gate.tsx';
import { Shell } from './screens/Shell.tsx';

function App() {
  const { ready, user, pairingRequired } = useSession();
  useEffect(() => {
    void loadSession();
  }, []);
  if (!ready) {
    return (
      <div className="boot">
        <Spinner size={26} />
      </div>
    );
  }
  if (pairingRequired) {
    return (
      <>
        <PairGate />
        <Toasts />
      </>
    );
  }
  return user ? (
    <Shell key={user.id} />
  ) : (
    <>
      <Gate />
      <Toasts />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
