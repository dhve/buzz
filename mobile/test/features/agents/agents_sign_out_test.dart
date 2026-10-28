import 'package:buzz/features/agents/create_agent_sheet.dart';
import 'package:buzz/shared/hosted/hosted_environment.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agents_harness.dart';

void main() {
  testWidgets(
    'signing out of Builderlab closes Create agent and Agents together',
    (tester) async {
      final h = await AgentsHarness.create();
      await h.open(tester, directory: ['a' * 64]);
      await tester.tap(find.byTooltip('Add agent'));
      await tester.pumpAndSettle();
      expect(find.byType(CreateAgentSheet), findsOneWidget);
      expect(find.byType(BottomSheet), findsNWidgets(2));

      h.registry.signedIn = false;
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('Open Agents'), findsOneWidget);
    },
    skip: !HostedEnvironment.enabled,
  );
}
