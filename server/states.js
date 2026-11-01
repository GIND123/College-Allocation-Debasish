// States and union territories offered at sign-up. Every dataset is tagged
// with one of these, and a candidate sees only their own state's data.
export const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal'
];

// National data (the MCC's All India Quota) is tagged with this instead of a state; everyone sees it.
export const ALL_INDIA = 'All India';

/** Canonical spelling of a state name, or '' if it is not one. */
export const normState = s => STATES.find(x => x.toLowerCase() === String(s || '').trim().toLowerCase()) || '';
