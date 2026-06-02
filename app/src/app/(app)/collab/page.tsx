import { Metadata } from 'next';
import { CollabChat } from '@/components/collab/collab-chat';

export const metadata: Metadata = {
  title: 'Collab — AuraFlux',
  description: 'AI job assistant — configure your video job with guided help.',
};

export default function CollabPage() {
  return (
    <div className="flex flex-col h-full p-4 max-w-2xl mx-auto w-full">
      <CollabChat />
    </div>
  );
}
