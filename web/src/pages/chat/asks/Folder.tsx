// "Which site should go live?": the person picks a folder or drops a ZIP, right in the chat. The AI hears the upload, its name
// and what it is (the server fills that in from its own look), never a path.
import { FolderUp } from 'lucide-react';
import { SiteDrop } from '../../live/drop';
import { AskFrame, Footer, type KindProps } from './kit';

export function FolderAsk({ spec, askId, busy, error, send }: KindProps<'folder'>) {
  return (
    <AskFrame icon={<FolderUp size={17} />} title={spec.title} note={spec.note} titleId={`${askId}-t`}
      footer={<Footer onSkip={() => send({ cancelled: true }, 'Skipped')} busy={busy} error={error}>{null}</Footer>}>
      <SiteDrop compact disabled={busy} onReady={(u) => send({ uploadId: u.uploadId }, u.name)} />
    </AskFrame>
  );
}
