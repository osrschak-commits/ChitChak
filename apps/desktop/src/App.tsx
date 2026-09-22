import { useEffect, useState } from 'react';
import { AuthScreen } from './components/AuthScreen.js';
import { CallView } from './components/CallView.js';
import { ChatPanel } from './components/ChatPanel.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { FriendsPanel } from './components/FriendsPanel.js';
import { FriendsSidebar } from './components/FriendsSidebar.js';
import { GuildDialog } from './components/GuildDialog.js';
import { Celebrations } from './components/Celebrations.js';
import { MemberRail } from './components/MemberRail.js';
import { ProfileDialog } from './components/ProfileDialog.js';
import { ResetPasswordScreen, takeResetTokenFromUrl } from './components/ResetPasswordScreen.js';
import { ServerSettingsDialog } from './components/ServerSettingsDialog.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { VoiceSettingsDialog } from './components/VoiceSettingsDialog.js';
import { usePushToTalk } from './hooks/usePushToTalk.js';
import { serverHost } from './lib/api.js';
import { unlockSounds } from './lib/sounds.js';
import { useApp } from './store/app.js';

type Overlay = 'none' | 'profile' | 'voice-settings' | 'server-settings' | 'create-guild' | 'join-guild';

export function App() {
  const [overlay, setOverlay] = useState<Overlay>('none');
  /**
   * Read once, on mount, and stripped from the URL as it is read - so a reload
   * does not re-open the form and the token never sits in the address bar.
   */
  const [resetToken, setResetToken] = useState(takeResetTokenFromUrl);
  /** Which section the settings dialog opens on, so "Invite people" lands there. */
  const [settingsTab, setSettingsTab] = useState<'overview' | 'invites'>('overview');
  const [pttKey, setPttKey] = useState('F8');

  const boot = useApp((s) => s.boot);
  // Read from the store, never mirrored into local state. Signing out and a
  // session expiring both end in the store, and a copy here would not hear
  // about either.
  const authenticated = useApp((s) => s.authenticated);
  const markAuthenticated = useApp((s) => s.markAuthenticated);
  const signOut = useApp((s) => s.signOut);
  const user = useApp((s) => s.user);
  const gatewayStatus = useApp((s) => s.gatewayStatus);
  const selectedGuildId = useApp((s) => s.selectedGuildId);
  const mainView = useApp((s) => s.mainView);
  const scope = useApp((s) => s.scope);
  const membersVisible = useApp((s) => s.membersVisible);
  const selectedDmChannelId = useApp((s) => s.selectedDmChannelId);
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const mobileList = useApp((s) => s.mobileList);
  const mobileMembers = useApp((s) => s.mobileMembers);

  useEffect(() => {
    if (authenticated) void boot();
  }, [authenticated, boot]);

  useEffect(() => {
    void window.chitchak?.getPushToTalkKey().then(setPttKey);
  }, []);

  /*
    A browser keeps its audio context suspended until the page has been
    interacted with, and the web client is a browser. Waking it on the first
    click or key means the first notification actually makes a sound - which is
    the one that matters, because a silent first notification is indis-
    tinguishable from a broken feature.
  */
  useEffect(() => {
    const wake = () => unlockSounds();
    document.addEventListener('pointerdown', wake, { once: true });
    document.addEventListener('keydown', wake, { once: true });
    return () => {
      document.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
    };
  }, []);

  usePushToTalk(pttKey);

  // Before the auth check, not after: someone may be signed in on this device
  // and resetting precisely because they are not sure who else is. The reset
  // revokes every session anyway, so there is nothing to preserve behind it.
  if (resetToken) {
    return (
      <ResetPasswordScreen
        token={resetToken}
        onDone={() => {
          setResetToken(null);
          // The old session is dead server-side regardless of how this ended;
          // holding on to its tokens would only produce a shell that 401s.
          void signOut();
        }}
      />
    );
  }

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

  /*
    Which of the three regions a narrow window shows, full screen, instead of
    all three side by side. Irrelevant at desktop width - the CSS that reads
    `data-mobile-pane` only exists inside the narrow-window media query, so
    this costs nothing there beyond an attribute nobody looks at.
  */
  const mobilePane = mobileList ? 'list' : mobileMembers ? 'members' : 'main';

  return (
    <div className="shell">
      <TopBar
        onCreateServer={() => setOverlay('create-guild')}
        onJoinServer={() => setOverlay('join-guild')}
        onOpenProfile={() => setOverlay('profile')}
        onOpenVoiceSettings={() => setOverlay('voice-settings')}
      />

      <div className="shell__body" data-mobile-pane={mobilePane}>
        {/* Boundaries per region: a bug in the channel list should not take the
            call down with it, and vice versa. */}
        <div className="mobile-screen" data-screen="list">
          <ErrorBoundary scope="channel list">
            {scope === 'friends' ? (
              <FriendsSidebar />
            ) : (
              <Sidebar
                onOpenServerSettings={(tab) => {
                  setSettingsTab(tab);
                  setOverlay('server-settings');
                }}
              />
            )}
          </ErrorBoundary>
        </div>

        {/* A call and a text channel are separate places, not a call stacked on
            top of a channel. Switching between them is what the sidebar does. */}
        <div className="mobile-screen" data-screen="main">
          <ErrorBoundary scope={mainView === 'call' ? 'call view' : 'chat'}>
            {mainView === 'call' && voiceChannelId ? (
              <CallView />
            ) : scope === 'friends' && selectedDmChannelId === null ? (
              // A conversation renders through the ordinary chat panel: a DM is an
              // ordinary channel, and deserves the same reading experience.
              <FriendsPanel />
            ) : (
              <ChatPanel onEditProfile={() => setOverlay('profile')} />
            )}
          </ErrorBoundary>
        </div>

        {/* Not in the friends scope: there is no server there to list, and the
            conversation list on the left is already the roster. `mobileMembers`
            is its own screen, independent of the desktop rail's remembered
            preference - opening it on a phone must not depend on what that
            preference happens to be, and must not change it either. */}
        {scope !== 'friends' && selectedGuildId && (membersVisible || mobileMembers) && (
          <div className="mobile-screen" data-screen="members">
            <ErrorBoundary scope="member list">
              <MemberRail guildId={selectedGuildId} />
            </ErrorBoundary>
          </div>
        )}
      </div>

      <Celebrations />

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
