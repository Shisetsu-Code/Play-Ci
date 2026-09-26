import test from 'node:test';
import assert from 'node:assert/strict';
import {
  visualProfileKey,
  indexVisualProfiles,
  matchVisualProfile,
  coordinateForBuy,
  coordinateForBooster,
} from '../src/visual-profiles.js';

test('matches visual profile by family and declared option counts', () => {
  const raw={version:1,profiles:[{
    id:'x',client_family:'goreel',buy_count:2,booster_count:0,
    buy_options:[{ordinal:0,x:1,y:2}],boosters:[]
  }]};
  const index=indexVisualProfiles(raw);
  const p=matchVisualProfile(index,{
    client_family:'goreel',
    protocol:{actions:['spin','buy_spin'],available_buy_bonus:[1,2],available_booster:[]}
  });
  assert.equal(p.id,'x');
  assert.deepEqual(coordinateForBuy(p,0),{ordinal:0,x:1,y:2});
  assert.equal(coordinateForBooster(p,0),null);
});

test('fixed buy counts as one visible buy option', () => {
  const raw={version:1,profiles:[{
    id:'fixed',client_family:'goreel',buy_count:1,booster_count:0,
    buy_options:[{ordinal:0,x:1,y:2}],boosters:[]
  }]};
  const p=matchVisualProfile(indexVisualProfiles(raw),{
    client_family:'goreel',
    protocol:{actions:['spin','buy_spin'],available_buy_bonus:[],available_booster:[],fixed_buy_multiplier:100}
  });
  assert.equal(p.id,'fixed');
});

test('profile key is stable',()=> {
  assert.equal(visualProfileKey({client_family:'ratpack',buy_count:2,booster_count:3}),'ratpack|buy=2|booster=3');
});
