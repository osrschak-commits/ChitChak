import { useEffect, useState } from 'react';
import { AuthScreen } from './components/AuthScreen.js';
import { CallView } from './components/CallView.js';
import { ChatPanel } from './components/ChatPanel.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { GuildDialog } from './components/GuildDialog.js';
import { ProfileDialog } from './components/ProfileDialog.js';
import { ServerSettingsDialog } from './components/ServerSettingsDialog.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { VoiceSettingsDialog } from './components/VoiceSettingsDialog.js';
import { usePushToTalk } from './hooks/usePushToTalk.js';
import { serverHost } from './lib/api.js';
import { useApp } from './store/app.js';

type Overlay = 'none' | 'profile' | 'voice-settings' | 'server-settings' | 'create-guild' | 'join-guild';

export function App() {
  const [overlay, setOverlay] = useState<Overlay>('none');
  /** Which section the settings dialog opens on, so "Invite people" lands there. */
  const [settingsTab, setSettingsTab] = useState<'overview' | 'invites'>('overview');
  const [pttKey, setPttKey] = useState('F8');

  const boot = useApp((s) => s.boot);
  // Read from the store, never mirrored into local state. Signing out and a
  // session expiring both end in the store, and a copy here would not hear
  // about either.
  const authenticated = useApp((s) => s.authenticated);
  const markAuthenticated = useApp((s) => s.markAuthenticated);
  const user = useApp((s) => s.user);
  const gatewayStatus = useApp((s) => s.gatewayStatus);
  const selectedGuildId = useApp((s) => s.selectedGuildId);
  const mainView = useApp((s) => s.mainView);
  const voiceChannelId = useApp((s) => s.voiceChannelId);

  useEffect(() => {
    if (authenticated) void boot();
  }, [authenticated, boot]);

  useEffect(() => {
    void window.chitchak?.getPushToTalkKey().then(setPttKey);
  }, []);

  usePushToTalk(pttKey);

  if (!authenticated) {
    return <AuthScreen onAuthenticated={markAuthenticated} />;
  }

  // The snapshot has not arrived yet. Rendering the shell against empty state
  // would flash an inaccurate "no servers" message on every launch.
  if (!user) {
    const unreachable = gatewayStatus === 'reconnecting' || gatewayStatus === 'closed';
    return (
      <div className="auth">
        <div className="empty__inner" style={{ textAlign: 'center' }}>
          <div className="auth__mark">CHITCHAK</div>
          {unreachable ? (
            <>
              <h2 className="empty__title">Cannot reach the server</h2>
              <p className="empty__body">
                Nothing is answering at {serverHost()}. This keeps retrying by itself.
              </p>
            </>
          ) : (
            <p className="empty__body">Connecting…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TopBar
        onCreateServer={() => setOverlay('create-guild')}
        onJoinServer={() => setOverlay('join-guild')}
        onOpenProfile={() => setOverlay('profile')}
        onOpenVoiceSettings={() => setOverlay('voice-settings')}
      />

      <div className="shell__body">
        {/* Boundaries per region: a bug in the channel list should not take the
            call down with it, and vice versa. */}
        <ErrorBoundary scope="channel list">
          <Sidebar
            onOpenServerSettings={(tab) => {
              setSettingsTab(tab);
              setOverlay('server-settings');
            }}
          />
        </ErrorBoundary>

        {/* A call and a text channel are separate places, not a call stacked on
            top of a channel. Switching between them is what the sidebar does. */}
        <ErrorBoundary scope={mainView === 'call' ? 'call view' : 'chat'}>
          {mainView === 'call' && voiceChannelId ? (
            <CallView />
          ) : (
            <ChatPanel onEditProfile={() => setOverlay('profile')} />
          )}
        </ErrorBoundary>
      </div>

      {overlay === 'profile' && <ProfileDialog onClose={() => setOverlay('none')} />}
      {overlay === 'voice-settings' && <VoiceSettingsDialog onClose={() => setOverlay('none')} />}
      {overlay === 'server-settings' && selectedGuildId && (
        <ServerSettingsDialog
          guildId={selectedGuildId}
          initialTab={settingsTab}
          onClose={() => setOverlay('none')}
        />
      )}
      {overlay === 'create-guild' && <GuildDialog mode="create" onClose={() => setOverlay('none')} />}
      {overlay === 'join-guild' && <GuildDialog mode="join" onClose={() => setOverlay('none')} />}
    </div>
  );
}
