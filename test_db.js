require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkTable() {
  const { data, error } = await supabase.from('helios_adapter_events').select('id').limit(1);
  if (error) {
    if (error.code === '42P01') {
      console.log('TABLE_MISSING');
      process.exit(0);
    } else {
      console.error(error);
      process.exit(1);
    }
  } else {
    console.log('TABLE_EXISTS');
  }
}
checkTable();
