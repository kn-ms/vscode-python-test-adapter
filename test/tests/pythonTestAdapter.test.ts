import { expect } from 'chai';
import 'mocha';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestEvent, TestLoadFinishedEvent, TestSuiteInfo } from 'vscode-test-adapter-api';

import { IConfigurationFactory } from '../../src/configuration/configurationFactory';
import { IWorkspaceConfiguration } from '../../src/configuration/workspaceConfiguration';
import { PytestTestRunner } from '../../src/pytest/pytestTestRunner';
import { PythonTestAdapter } from '../../src/pythonTestAdapter';
import { UnittestTestRunner } from '../../src/unittest/unittestTestRunner';
import {
    createPytestConfiguration,
    createUnittestConfiguration,
    extractExpectedState,
    extractErroredTests,
    findTestSuiteByLabel,
    findWorkspaceFolder,
    logger,
} from '../utils/helpers';
import { ITestRunner } from '../../src/testRunner';
import sinon, { SinonSpy } from 'sinon';
import { LoggingOutputCollector } from '../../src/loggingOutputCollector';

[
    {
        label: 'unittest',
        runner: new UnittestTestRunner('first-id', logger()),
        configuration: createUnittestConfiguration('unittest'),
        testsToRun: [
            'test_basic_two_plus_one_is_three_passed',
            'test_basic_two_plus_two_is_five_failed',
            'test_basic_two_plus_zero_is_two_skipped',
        ],
        suiteToSort: {
            suite: { label: 'AddTests', description: 'basic_tests.test_add' },
            sortedTests: [
                'test_basic_two_plus_one_is_three_passed',
                'test_basic_two_plus_two_is_five_failed',
                'test_basic_two_plus_zero_is_two_skipped',
            ],
        },
    },
    {
        label: 'pytest',
        runner: new PytestTestRunner('second-id', logger()),
        configuration: createPytestConfiguration('pytest', ['--ignore=test/import_error_tests']),
        testsToRun: ['test_one_plus_two_is_three_passed', 'test_two_plus_two_is_five_failed', 'test_capitalize_passed'],
        suiteToSort: {
            suite: { label: 'TestSampleWithScenarios' },
            sortedTests: ['test_demo1_passed', 'test_demo2_passed', 'test_demo10_passed'],
        },
    },
].forEach(({ label, runner, configuration, testsToRun, suiteToSort }) => {
    suite(`Adapter events with ${label} runner`, () => {
        const workspaceFolder = findWorkspaceFolder(label)!;
        const configurationFactory: IConfigurationFactory = {
            get(_: vscode.WorkspaceFolder): Promise<IWorkspaceConfiguration> {
                return Promise.resolve(configuration);
            },
        };

        test('discovery events should be successfully fired', async () => {
            const adapter = new PythonTestAdapter(label, workspaceFolder, runner, configurationFactory, logger());
            let startedNotifications = 0;
            let finishedNotifications = 0;
            let finishedEvent: TestLoadFinishedEvent | undefined;
            adapter.tests((event) => {
                if (event.type === 'started') {
                    startedNotifications++;
                } else {
                    finishedNotifications++;
                    finishedEvent = event;
                }
            });
            await adapter.load();

            expect(startedNotifications).to.be.eq(1);
            expect(startedNotifications).to.be.eq(finishedNotifications);

            expect(finishedEvent!.errorMessage).to.be.undefined;
            expect(finishedEvent!.suite).to.be.not.undefined;
            expect(finishedEvent!.suite!.children).to.be.not.empty;
        });

        test(`test execution events should be successfully fired for ${label}`, async () => {
            const adapter = new PythonTestAdapter(label, workspaceFolder, runner, configurationFactory, logger());
            const mainSuite = await runner.load(await configurationFactory.get(workspaceFolder));
            // expect(errors).to.be.empty;
            expect(mainSuite).to.be.not.undefined;
            const suites = testsToRun.map((t) => findTestSuiteByLabel(mainSuite!, t)!);

            let startedNotifications = 0;
            let finishedNotifications = 0;
            const states: TestEvent[] = [];
            adapter.testStates((event) => {
                if (event.type === 'started') {
                    startedNotifications++;
                } else if (event.type === 'finished') {
                    finishedNotifications++;
                } else if (event.type === 'test') {
                    states.push(event);
                } else {
                    /* */
                }
            });
            await adapter.run(suites.map((s) => s.id));

            expect(startedNotifications).to.be.eq(1);
            expect(startedNotifications).to.be.eq(finishedNotifications);

            expect(states).to.be.not.empty;
            expect(states).to.have.length(testsToRun.length);
            states.forEach((state) => {
                const expectedState = extractExpectedState(state.test as string);
                expect(state.state).to.be.eq(expectedState);
            });
        });

        test('discovered tests should be sorted alphabetically', async () => {
            const adapter = new PythonTestAdapter(label, workspaceFolder, runner, configurationFactory, logger());
            let startedNotifications = 0;
            let finishedNotifications = 0;
            let finishedEvent: TestLoadFinishedEvent | undefined;
            adapter.tests((event) => {
                if (event.type === 'started') {
                    startedNotifications++;
                } else {
                    finishedNotifications++;
                    finishedEvent = event;
                }
            });
            await adapter.load();

            expect(startedNotifications).to.be.eq(1);
            expect(startedNotifications).to.be.eq(finishedNotifications);

            expect(finishedEvent!.errorMessage).to.be.undefined;
            expect(finishedEvent!.suite).to.be.not.undefined;
            expect(finishedEvent!.suite!.children).to.be.not.empty;

            const suiteToCheck = findTestSuiteByLabel(
                finishedEvent!.suite!,
                suiteToSort.suite.label,
                suiteToSort.suite.description
            )! as TestSuiteInfo;
            expect(suiteToCheck.type).to.be.eq('suite');
            expect(suiteToCheck.children).to.be.not.empty;
            expect(suiteToCheck.children.map((t) => t.label)).to.have.ordered.members(suiteToSort.sortedTests);
        });
    });
});

suite('Adapter events with pytest runner and invalid files during discovery', () => {
    const testsToRun = ['Error in invalid_syntax_test.py', 'Error in non_existing_module_test.py'];
    const workspaceFolder = findWorkspaceFolder('pytest')!;
    const configurationFactory: IConfigurationFactory = {
        get(_: vscode.WorkspaceFolder): Promise<IWorkspaceConfiguration> {
            return Promise.resolve(createPytestConfiguration('pytest'));
        },
    };
    const runner = new PytestTestRunner('some-id', logger());
    const adapter = new PythonTestAdapter('pytest', workspaceFolder, runner, configurationFactory, logger());

    test('discovery events should be successfully fired', async () => {
        let startedNotifications = 0;
        let finishedNotifications = 0;
        let finishedEvent: TestLoadFinishedEvent | undefined;
        adapter.tests((event) => {
            if (event.type === 'started') {
                startedNotifications++;
            } else {
                finishedNotifications++;
                finishedEvent = event;
            }
        });
        await adapter.load();

        expect(startedNotifications).to.be.eq(1);
        expect(startedNotifications).to.be.eq(finishedNotifications);

        expect(finishedEvent!.errorMessage).to.be.undefined;
        expect(finishedEvent!.suite).to.be.not.undefined;
        expect(finishedEvent!.suite!.children).to.be.not.empty;
    });

    test('test execution events should be successfully fired for pytest', async () => {
        const mainSuite = await runner.load(await configurationFactory.get(workspaceFolder));
        expect(mainSuite).to.be.not.undefined;
        expect(extractErroredTests(mainSuite!)).to.have.length(2);
        const suites = testsToRun.map((t) => findTestSuiteByLabel(mainSuite!, t)!);

        let startedNotifications = 0;
        let finishedNotifications = 0;
        const states: TestEvent[] = [];
        adapter.testStates((event) => {
            if (event.type === 'started') {
                startedNotifications++;
            } else if (event.type === 'finished') {
                finishedNotifications++;
            } else if (event.type === 'test') {
                states.push(event);
            } else {
                /* */
            }
        });
        await adapter.run(suites.map((s) => s.id));

        expect(startedNotifications).to.be.eq(1);
        expect(startedNotifications).to.be.eq(finishedNotifications);

        expect(states).to.be.not.empty;
        expect(states).to.have.length(testsToRun.length);
        expect(states.map((s) => ({ state: s.state, id: s.test }))).to.have.deep.members([
            {
                state: 'failed',
                id: path.join(workspaceFolder.uri.fsPath, 'test', 'import_error_tests', 'invalid_syntax_test.py'),
            },
            {
                state: 'failed',
                id: path.join(workspaceFolder.uri.fsPath, 'test', 'import_error_tests', 'non_existing_module_test.py'),
            },
        ]);
    });
});

suite('Adapter events with unittest runner and invalid files during discovery', () => {
    const testsToRun = ['test_invalid_syntax_failed', 'InvalidTestIdTests_failed', 'test_invalid_import_failed'];
    const workspaceFolder = findWorkspaceFolder('unittest')!;
    const configurationFactory: IConfigurationFactory = {
        get(_: vscode.WorkspaceFolder): Promise<IWorkspaceConfiguration> {
            return Promise.resolve(createUnittestConfiguration('unittest'));
        },
    };
    const runner = new UnittestTestRunner('some-id', logger());
    const adapter = new PythonTestAdapter('unittest', workspaceFolder, runner, configurationFactory, logger());

    test('discovery events should be successfully fired', async () => {
        let startedNotifications = 0;
        let finishedNotifications = 0;
        let finishedEvent: TestLoadFinishedEvent | undefined;
        adapter.tests((event) => {
            if (event.type === 'started') {
                startedNotifications++;
            } else {
                finishedNotifications++;
                finishedEvent = event;
            }
        });
        await adapter.load();

        expect(startedNotifications).to.be.eq(1);
        expect(startedNotifications).to.be.eq(finishedNotifications);

        expect(finishedEvent!.errorMessage).to.be.undefined;
        expect(finishedEvent!.suite).to.be.not.undefined;
        expect(finishedEvent!.suite!.children).to.be.not.empty;
    });

    test('test execution events should be successfully fired for unittest', async () => {
        const mainSuite = await runner.load(await configurationFactory.get(workspaceFolder));
        expect(mainSuite).to.be.not.undefined;
        expect(extractErroredTests(mainSuite!)).to.have.length(3);
        const suites = testsToRun.map((t) => findTestSuiteByLabel(mainSuite!, t)!);

        let startedNotifications = 0;
        let finishedNotifications = 0;
        const states: TestEvent[] = [];
        adapter.testStates((event) => {
            if (event.type === 'started') {
                startedNotifications++;
            } else if (event.type === 'finished') {
                finishedNotifications++;
            } else if (event.type === 'test') {
                states.push(event);
            } else {
                /* */
            }
        });
        await adapter.run(suites.map((s) => s.id));

        expect(startedNotifications).to.be.eq(1);
        expect(startedNotifications).to.be.eq(finishedNotifications);

        expect(states).to.be.not.empty;
        expect(states).to.have.length(testsToRun.length);
        expect(states.map((s) => ({ state: s.state, id: s.test }))).to.have.deep.members([
            {
                state: 'failed',
                id: 'invalid_tests.test_invalid_syntax_failed',
            },
            {
                state: 'failed',
                id: 'invalid_tests.test_invalid_test_id.InvalidTestIdTests_failed',
            },
            {
                state: 'failed',
                id: 'test_invalid_import_failed',
            },
        ]);
    });
});

suite('Runner Output', () => {
    const runner = <ITestRunner>{};
    let collectOutputs = false;
    let run: SinonSpy;
    const testNames = ['Test1', 'Test2'];

    setup('setup run spy', () => {
        run = sinon.spy();
        runner.run = run;
    });

    const workspaceFolder = findWorkspaceFolder('unittest')!;
    const configurationFactory: IConfigurationFactory = {
        get(_: vscode.WorkspaceFolder): Promise<IWorkspaceConfiguration> {
            return Promise.resolve(<IWorkspaceConfiguration>{
                collectOutputs: () => collectOutputs,
                showOutputsOnRun: () => false,
            });
        },
    };

    test('should be collected when configured to collect', async () => {
        // Given
        collectOutputs = true;

        // When
        const adapter = new PythonTestAdapter('unittest', workspaceFolder, runner, configurationFactory, logger());
        await adapter.run(testNames);

        // Then
        expect(run.calledTwice).is.true;
        const collector = run.lastCall.lastArg;
        expect(collector).is.not.undefined;
        expect(collector).is.an.instanceOf(LoggingOutputCollector);
    });

    test('should not be collected when configured not to collect', async () => {
        // Given
        collectOutputs = false;

        // When
        const adapter = new PythonTestAdapter('unittest', workspaceFolder, runner, configurationFactory, logger());
        await adapter.run(testNames);

        // Then
        expect(run.calledTwice).is.true;
        expect(run.lastCall.lastArg).is.undefined;
    });
});
