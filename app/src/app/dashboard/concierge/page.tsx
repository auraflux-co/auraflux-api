import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function ConciergePage() {
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AI Concierge</h1>
        <Badge variant="secondary">dwy+</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job spec assistant</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The AI Concierge chat widget will be built here in CPD-47.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
