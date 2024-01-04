/**
 * this test checks the integration with firestore
 * You need a running firebase backend
 */
import assert from 'assert';

import {
    randomCouchString,
    RxCollection,
    ensureNotFalsy,
    WithDeleted,
    createRxDatabase
} from '../plugins/core/index.mjs';

import * as firebase from 'firebase/app';

import * as humansCollection from './helper/humans-collection.ts';
import * as schemaObjects from './helper/schema-objects.ts';


import {
    CollectionReference,
    getFirestore,
    collection as getFirestoreCollection,
    connectFirestoreEmulator,
    getDocs,
    query,
    doc as DocRef,
    setDoc,
    serverTimestamp,
    where,
    orderBy,
    limit,
    getDoc
} from 'firebase/firestore';
import {
    FirestoreOptions,
    replicateFirestore,
    RxFirestoreReplicationState,
    SyncOptionsFirestore
} from '../plugins/replication-firestore/index.mjs';
import { ensureCollectionsHaveEqualState, ensureReplicationHasNoErrors } from './helper/test-util.ts';
import { HumanDocumentType } from './helper/schemas.ts';
import config from './unit/config.ts';


/**
 * The tests for the firestore replication plugin
 * do not run in the normal test suite
 * because it is too slow to setup the firestore backend emulators.
 */
describe('replication-firestore.test.js', function () {
    this.timeout(1000 * 20);
    /**
     * Use a low batchSize in all tests
     * to make it easier to test boundaries.
     */
    const batchSize = 5;
    type TestDocType = schemaObjects.HumanWithTimestampDocumentType;
    async function getAllDocsOfFirestore(firestore: FirestoreOptions<TestDocType>): Promise<TestDocType[]> {
        const result = await getDocs(query(firestore.collection));
        return result.docs.map(d => {
            const docData = d.data();
            (docData as any).id = d.id;
            return docData;
        }) as any;
    }
    const projectId = randomCouchString(10);
    const app = firebase.initializeApp({
        projectId,
        databaseURL: 'http://localhost:8080?ns=' + projectId
    });
    const database = getFirestore(app);
    connectFirestoreEmulator(database, 'localhost', 8080);

    function getFirestoreState(): FirestoreOptions<TestDocType> {
        const useCollection: CollectionReference<TestDocType> = getFirestoreCollection(database, randomCouchString(10)) as any;
        return {
            projectId,
            collection: useCollection,
            database
        };
    }
    async function syncOnce(collection: RxCollection, firestoreState: FirestoreOptions<any>, options?: Pick<SyncOptionsFirestore<any>, 'pull' | 'push'>) {
        const replicationState = replicateFirestore({
            replicationIdentifier: firestoreState.projectId,
            collection,
            firestore: firestoreState,
            live: false,
            pull: options?.pull ?? {},
            push: options?.push ?? {},
        });
        ensureReplicationHasNoErrors(replicationState);
        await replicationState.awaitInitialReplication();
    }
    function syncFirestore<RxDocType = TestDocType>(
        collection: RxCollection<RxDocType>,
        firestoreState: FirestoreOptions<RxDocType>
    ): RxFirestoreReplicationState<RxDocType> {
        const replicationState = replicateFirestore({
            replicationIdentifier: randomCouchString(10),
            collection,
            firestore: firestoreState,
            pull: {
                batchSize
            },
            push: {
                batchSize
            }
        });
        ensureReplicationHasNoErrors(replicationState);
        return replicationState;
    }

    function makeFirestoreHumanDocument(human: HumanDocumentType) {
        const firestoreHuman: any = { ...human };
        firestoreHuman.id = firestoreHuman.passportId;
        delete firestoreHuman.passportId;

        firestoreHuman.serverTimestamp = serverTimestamp();

        return firestoreHuman as any;
    }

    describe('preconditions', () => {
        it('query sorted by server timestamp', async () => {
            const firestoreState = await getFirestoreState();

            // it should be able to query sorted by serverTimestamp
            await setDoc(DocRef(firestoreState.collection, 'older'), {
                id: 'older',
                serverTimestamp: serverTimestamp()
            } as any);
            await setDoc(DocRef(firestoreState.collection, 'younger'), {
                id: 'younger',
                serverTimestamp: serverTimestamp()
            } as any);
            const docsOnServer = await getAllDocsOfFirestore(firestoreState);
            const olderDoc = ensureNotFalsy(docsOnServer.find(d => d.id === 'older'));
            const queryTimestamp = (olderDoc as any).serverTimestamp.toDate();
            const newerQuery = query(firestoreState.collection,
                where('serverTimestamp', '>', queryTimestamp),
                orderBy('serverTimestamp', 'asc'),
                limit(10)
            );
            const queryResult = await getDocs<TestDocType, any>(newerQuery as any);
            assert.strictEqual(queryResult.docs.length, 1);
            assert.strictEqual(
                ensureNotFalsy(queryResult.docs[0]).data().id,
                'younger'
            );
        });
    });
    describe('live replication', () => {
        it('push replication to client-server', async () => {
            const collection = await humansCollection.createHumanWithTimestamp(2, undefined, false);

            const firestoreState = await getFirestoreState();

            const replicationState = syncFirestore(collection, firestoreState);
            ensureReplicationHasNoErrors(replicationState);
            await replicationState.awaitInitialReplication();

            let docsOnServer = await getAllDocsOfFirestore(firestoreState);
            assert.strictEqual(docsOnServer.length, 2);

            // insert another one
            await collection.insert(schemaObjects.humanWithTimestamp());
            await replicationState.awaitInSync();

            docsOnServer = await getAllDocsOfFirestore(firestoreState);
            assert.strictEqual(docsOnServer.length, 3);

            // update one
            const doc = await collection.findOne().exec(true);
            await doc.incrementalPatch({ age: 100 });
            await replicationState.awaitInSync();
            docsOnServer = await getAllDocsOfFirestore(firestoreState);
            assert.strictEqual(docsOnServer.length, 3);
            const serverDoc = ensureNotFalsy(docsOnServer.find(d => d.id === doc.primary));
            assert.strictEqual(serverDoc.age, 100);

            // delete one
            await doc.getLatest().remove();
            await replicationState.awaitInSync();
            docsOnServer = await getAllDocsOfFirestore(firestoreState);
            // must still have 3 because there are no hard deletes
            assert.strictEqual(docsOnServer.length, 3);
            assert.ok(docsOnServer.find(d => (d as any)._deleted));

            collection.database.destroy();
        });
        it('two collections', async () => {
            const collectionA = await humansCollection.createHumanWithTimestamp(1, undefined, false);
            const collectionB = await humansCollection.createHumanWithTimestamp(1, undefined, false);

            const firestoreState = await getFirestoreState();
            const replicationStateA = syncFirestore(collectionA, firestoreState);

            ensureReplicationHasNoErrors(replicationStateA);
            await replicationStateA.awaitInitialReplication();


            const replicationStateB = syncFirestore(collectionB, firestoreState);
            ensureReplicationHasNoErrors(replicationStateB);
            await replicationStateB.awaitInitialReplication();

            await replicationStateA.awaitInSync();

            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // insert one
            await collectionA.insert(schemaObjects.humanWithTimestamp({ id: 'insert', name: 'InsertName' }));
            await replicationStateA.awaitInSync();

            await replicationStateB.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // delete one
            await collectionB.findOne().remove();
            await replicationStateB.awaitInSync();
            await replicationStateA.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // insert many
            await collectionA.bulkInsert(
                new Array(10)
                    .fill(0)
                    .map(() => schemaObjects.humanWithTimestamp({ name: 'insert-many' }))
            );
            await replicationStateA.awaitInSync();

            await replicationStateB.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // insert at both collections at the same time
            await Promise.all([
                collectionA.insert(schemaObjects.humanWithTimestamp({ name: 'insert-parallel-A' })),
                collectionB.insert(schemaObjects.humanWithTimestamp({ name: 'insert-parallel-B' }))
            ]);
            await replicationStateA.awaitInSync();
            await replicationStateB.awaitInSync();
            await replicationStateA.awaitInSync();
            await replicationStateB.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            collectionA.database.destroy();
            collectionB.database.destroy();
        });
    });
    describe('conflict handling', () => {
        it('should keep the master state as default conflict handler', async () => {
            const firestoreState = await getFirestoreState();
            const c1 = await humansCollection.create(1);
            const c2 = await humansCollection.create(0);

            await syncOnce(c1, firestoreState);
            await syncOnce(c2, firestoreState);

            const doc1 = await c1.findOne().exec(true);
            const doc2 = await c2.findOne().exec(true);

            // make update on both sides
            await doc1.incrementalPatch({ firstName: 'c1' });
            await doc2.incrementalPatch({ firstName: 'c2' });

            await syncOnce(c2, firestoreState);

            // cause conflict
            await syncOnce(c1, firestoreState);

            /**
             * Must have kept the master state c2
             */
            assert.strictEqual(doc1.getLatest().firstName, 'c2');

            c1.database.destroy();
            c2.database.destroy();
        });
    });

    describe('filtered replication', () => {
        it('should only sync filtered documents from firestore', async () => {
            const firestoreState = getFirestoreState();

            const h1 = makeFirestoreHumanDocument(schemaObjects.human('replicated', 35, 'replicated'));
            const h2 = makeFirestoreHumanDocument(schemaObjects.human('not replicated', 27, 'not replicated'));

            await setDoc(DocRef(firestoreState.collection, 'replicated'), h1);
            await setDoc(DocRef(firestoreState.collection, 'not replicated'), h2);

            const collection = await humansCollection.create(0);

            await syncOnce(collection, firestoreState, {
                pull: {
                    filter: where('firstName', '==', 'replicated')
                },
                push: {},
            });

            const allLocalDocs = await collection.find().exec();

            assert.strictEqual(allLocalDocs.length, 1);
            assert.strictEqual(allLocalDocs[0].passportId, 'replicated');

            collection.database.destroy();
        });

        it('should only sync filtered documents to firestore', async () => {
            const firestoreState = getFirestoreState();

            const collection = await humansCollection.create(0);


            await collection.insert(schemaObjects.human('replicated', 35, 'filtered-replication-c2s-1'));
            await collection.insert(schemaObjects.human('not replicated', 27, 'filtered-replication-c2s-2'));

            await syncOnce(collection, firestoreState, {
                pull: {},
                push: {
                    filter(human: WithDeleted<HumanDocumentType>) {
                        return human.age > 30;
                    },
                },
            });

            const docsOnServer = await getAllDocsOfFirestore(firestoreState);

            assert.strictEqual(docsOnServer.length, 1);
            assert.strictEqual(docsOnServer[0].id, 'replicated');

            collection.database.destroy();
        });
    });
    describe('issues', () => {
        it('#4698 adding items quickly does not send them to the server', async () => {
            const mySchema = {
                version: 0,
                primaryKey: 'passportId',
                type: 'object',
                properties: {
                    passportId: {
                        type: 'string',
                        maxLength: 100
                    },
                    firstName: {
                        type: 'string'
                    },
                    lastName: {
                        type: 'string'
                    },
                    age: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 150
                    }
                }
            };

            /**
             * Always generate a random database-name
             * to ensure that different test runs do not affect each other.
             */
            const name = randomCouchString(10);

            // create a database
            const db = await createRxDatabase({
                name,
                /**
                 * By calling config.storage.getStorage(),
                 * we can ensure that all variations of RxStorage are tested in the CI.
                 */
                storage: config.storage.getStorage(),
                eventReduce: true,
                ignoreDuplicate: true
            });

            // create a collection
            const collections = await db.addCollections({
                mycollection: {
                    schema: mySchema
                }
            });

            const firestoreState = getFirestoreState();

            const replicationState = replicateFirestore({
                replicationIdentifier: firestoreState.projectId,
                firestore: firestoreState,
                collection: db.collections.mycollection,
                pull: {},
                push: {},
                live: true,
            });
            replicationState.sent$.subscribe(x => {
                console.log('# send:');
                console.dir(x);
            });
            ensureReplicationHasNoErrors(replicationState);

            // insert a document
            const doc = await collections.mycollection.insert({
                passportId: 'foobar',
                firstName: 'Bob',
                lastName: 'Kelso',
                age: 56
            });
            await replicationState.awaitInitialReplication();

            await doc.incrementalPatch({ age: 60 });
            await doc.incrementalPatch({ age: 30 });
            await replicationState.awaitInSync();

            // ensure correct local value
            const myDocument = await collections.mycollection.findOne({ selector: { passportId: 'foobar' } }).exec();
            assert.strictEqual(myDocument.age, 30);


            // ensure correct remote value
            const docRef = DocRef(firestoreState.collection, 'foobar');
            const docSnap = ensureNotFalsy(await getDoc(docRef));

            assert.strictEqual(ensureNotFalsy(docSnap.data()).age, 30);

            // clean up afterwards
            db.destroy();
        });
    });
});
