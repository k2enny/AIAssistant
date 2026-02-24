import { EventBus, Events } from '../src/core/event-bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  test('should emit and receive events', (done) => {
    bus.on('test', (data) => {
      expect(data).toEqual({ message: 'hello' });
      done();
    });
    bus.emit('test', { message: 'hello' });
  });

  test('should support wildcard listener', (done) => {
    bus.on('*', (data) => {
      expect(data.event).toBe('test:event');
      expect(data.data).toEqual({ value: 42 });
      done();
    });
    bus.emit('test:event', { value: 42 });
  });

  test('should support once listener', () => {
    let count = 0;
    bus.once('test', () => { count++; });
    bus.emit('test', {});
    bus.emit('test', {});
    expect(count).toBe(1);
  });

  test('should remove listener with off', () => {
    let count = 0;
    const handler = () => { count++; };
    bus.on('test', handler);
    bus.emit('test', {});
    bus.off('test', handler);
    bus.emit('test', {});
    expect(count).toBe(1);
  });

  test('should maintain event history', () => {
    bus.emit('event1', { a: 1 });
    bus.emit('event2', { b: 2 });
    bus.emit('event1', { c: 3 });

    const history = bus.getHistory();
    expect(history.length).toBe(3);
    expect(history[0].event).toBe('event1');
    expect(history[2].event).toBe('event1');
  });

  test('should filter history by event name', () => {
    bus.emit('event1', { a: 1 });
    bus.emit('event2', { b: 2 });
    bus.emit('event1', { c: 3 });

    const history = bus.getHistory('event1');
    expect(history.length).toBe(2);
  });

  test('should limit history size', () => {
    const smallBus = new EventBus(5);
    for (let i = 0; i < 10; i++) {
      smallBus.emit('test', { i });
    }
    const history = smallBus.getHistory();
    expect(history.length).toBe(5);
    expect(history[0].data.i).toBe(5);
  });

  test('should report listener count', () => {
    const h1 = () => {};
    const h2 = () => {};
    bus.on('test', h1);
    bus.on('test', h2);
    expect(bus.listenerCount('test')).toBe(2);
  });

  test('should have well-known event constants', () => {
    expect(Events.MESSAGE_RECEIVED).toBe('message:received');
    expect(Events.DAEMON_STARTED).toBe('daemon:started');
    expect(Events.PLUGIN_LOADED).toBe('plugin:loaded');
    expect(Events.POLICY_DECISION).toBe('policy:decision');
    expect(Events.TOOL_EXECUTING).toBe('tool:executing');
  });
});
