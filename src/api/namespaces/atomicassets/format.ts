export function formatAsset(row: any): any {
    const data = {...row};

    data.collection = formatCollection(data.collection);

    data['data'] = {};

    Object.assign(data['data'], data.mutable_data);
    Object.assign(data['data'], data.immutable_data);

    if (data.template) {
        Object.assign(data['data'], data.template.immutable_data);
    }

    delete data['template_id'];
    delete data['schema_name'];
    delete data['collection_name'];
    delete data['authorized_accounts'];

    return data;
}

export function formatTemplate(row: any): any {
    const data = {...row};

    data.collection = formatCollection(data.collection);

    delete data['schema_name'];
    delete data['collection_name'];
    delete data['authorized_accounts'];

    return data;
}

export function formatSchema(row: any): any {
    const data = {...row};

    data.collection = formatCollection(data.collection);

    delete data['collection_name'];
    delete data['authorized_accounts'];

    return data;
}

export function formatCollection(row: any): any {
    return row;
}

export function formatOffer(row: any): any {
    return {...row};
}

export function formatTransfer(row: any): any {
    const data = {...row};

    delete data['transfer_id'];

    return data;
}
